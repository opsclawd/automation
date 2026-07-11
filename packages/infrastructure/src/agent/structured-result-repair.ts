import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentInvocationId, AgentProfileName } from '@ai-sdlc/domain';
import type {
  AgentInvocationRequest,
  AgentInvocationResult,
  AgentPort,
  GitPort,
  StructuredResultRepairInput,
  StructuredResultRepairPort,
  StructuredResultRepairResult,
} from '@ai-sdlc/application/ports';

const TAIL_MAX_BYTES = 8 * 1024;
const PROMPT_MAX_BYTES = 8 * 1024;
const DEFAULT_REPAIR_PROFILE = 'task-reviewer';

export interface BuildStructuredResultRepairPromptInput {
  destination: string;
  schemaContractText: string;
  cappedRawArtifact: string;
  stdoutTail: string;
}

export function buildStructuredResultRepairPrompt(
  input: BuildStructuredResultRepairPromptInput,
): string {
  return [
    'You are repairing a malformed structured result.',
    `Write valid JSON only to ${input.destination}.`,
    'Do not modify any other file.',
    '',
    '## Schema contract',
    '```text',
    input.schemaContractText,
    '```',
    '',
    '## Malformed artifact',
    '```text',
    input.cappedRawArtifact,
    '```',
    '',
    '## Bounded stdout tail',
    '```text',
    input.stdoutTail,
    '```',
    '',
    '## Instruction',
    `Write valid JSON only to ${input.destination}.`,
    'Do not emit prose.',
  ].join('\n');
}

interface StructuredResultRepairOptions {
  git: GitPort;
  agent: AgentPort;
  repairProfile?: string;
  promptBuilder?: (input: BuildStructuredResultRepairPromptInput) => string;
  readTailBytes?: (path: string) => string;
  idFactory?: () => string;
}

interface FileSnapshot {
  contents: string;
}

export class StructuredResultRepair implements StructuredResultRepairPort {
  private readonly git: GitPort;
  private readonly agent: AgentPort;
  private readonly repairProfile: string;
  private readonly promptBuilder: (input: BuildStructuredResultRepairPromptInput) => string;
  private readonly readTailBytes: (path: string) => string;
  private readonly idFactory: () => string;

  constructor(opts: StructuredResultRepairOptions) {
    this.git = opts.git;
    this.agent = opts.agent;
    this.repairProfile = opts.repairProfile ?? DEFAULT_REPAIR_PROFILE;
    this.promptBuilder = opts.promptBuilder ?? buildStructuredResultRepairPrompt;
    this.readTailBytes = opts.readTailBytes ?? defaultReadTailBytes;
    this.idFactory = opts.idFactory ?? (() => randomUUID());
  }

  async repairStructuredResult(
    input: StructuredResultRepairInput,
  ): Promise<StructuredResultRepairResult> {
    if (!input.primaryInvocation?.stdoutPath || !input.primaryInvocation?.id) {
      return { outcome: 'not_attempted' };
    }

    const destinationAbs = resolvePathWithinCwd(input.cwd, input.destination);
    if (!destinationAbs) {
      return { outcome: 'not_attempted' };
    }

    if (!existsSync(destinationAbs)) {
      return { outcome: 'not_attempted' };
    }

    if (!this.matchesRawArtifact(destinationAbs, input.cappedRawArtifact)) {
      return { outcome: 'not_attempted' };
    }

    const currentHead = await this.safeHeadCommitSha(input.cwd);
    if (currentHead !== undefined && currentHead !== input.expectedHead) {
      return { outcome: 'not_attempted' };
    }

    const stdoutTail = this.readTailBytes(input.primaryInvocation.stdoutPath);
    if (stdoutTail.trim().length === 0 && input.transcriptEvidence.trim().length === 0) {
      return { outcome: 'not_attempted' };
    }

    const preSnapshot = await this.snapshotChangedPaths(input.cwd, destinationAbs);
    const prompt = this.promptBuilder({
      destination: input.destination,
      schemaContractText: input.schemaContractText,
      cappedRawArtifact: capText(input.cappedRawArtifact, PROMPT_MAX_BYTES),
      stdoutTail: capText(stdoutTail, TAIL_MAX_BYTES),
    });
    const promptPath = this.writePromptFile(prompt);
    const repairInvocationId = AgentInvocationId(this.idFactory());

    const request: AgentInvocationRequest = {
      profile: AgentProfileName(this.repairProfile),
      promptPath,
      expectedArtifacts: [input.destination],
      cwd: input.cwd,
      runId: input.runId,
      repoId: input.cwd,
      phaseId: input.normalizedPhase,
      startCommitSha: input.expectedHead,
      fallbackOfInvocationId: input.primaryInvocation.id,
      fallbackReason: 'serialization_repair',
      metadata: {
        invocation_type: 'serialization_repair',
        classification: input.classification,
        normalized_phase: input.normalizedPhase,
        transcript_evidence: input.transcriptEvidence,
        source_stdout_path: input.primaryInvocation.stdoutPath,
        source_stderr_path: input.primaryInvocation.stderrPath,
      },
    };

    let result: AgentInvocationResult;
    try {
      result = await this.agent.invoke(request);
    } catch {
      await this.cleanupFailedRepair(input, destinationAbs, preSnapshot);
      return {
        outcome: 'failed',
        repairInvocationId,
      };
    } finally {
      removePromptFile(promptPath);
    }

    if (result.outcome !== 'success' || result.exitCode !== 0) {
      await this.cleanupFailedRepair(input, destinationAbs, preSnapshot);
      return {
        outcome: 'failed',
        repairInvocationId,
      };
    }

    if (this.matchesRawArtifact(destinationAbs, input.cappedRawArtifact)) {
      await this.cleanupFailedRepair(input, destinationAbs, preSnapshot);
      return {
        outcome: 'failed',
        repairInvocationId,
      };
    }

    const postStatus = await this.safeStatusPaths(input.cwd);
    if (!(await this.onlyDestinationChanged(input.cwd, destinationAbs, preSnapshot, postStatus))) {
      await this.cleanupFailedRepair(input, destinationAbs, preSnapshot);
      return {
        outcome: 'failed',
        repairInvocationId,
      };
    }

    if (!existsSync(destinationAbs)) {
      await this.cleanupFailedRepair(input, destinationAbs, preSnapshot);
      return {
        outcome: 'failed',
        repairInvocationId,
      };
    }

    return {
      outcome: 'repaired',
      repairInvocationId,
    };
  }

  private async cleanupFailedRepair(
    input: StructuredResultRepairInput,
    destinationAbs: string,
    preSnapshot: Map<string, FileSnapshot>,
  ): Promise<void> {
    try {
      writeFileSync(destinationAbs, input.cappedRawArtifact);
    } catch {
      // Best-effort cleanup; the other snapshot restores still matter.
    }

    const postStatus = await this.safeStatusPaths(input.cwd);
    for (const [relPath, snapshot] of preSnapshot) {
      if (relPath === input.destination) continue;
      try {
        writeFileSync(join(input.cwd, relPath), snapshot.contents);
      } catch {
        // If restoring from the snapshot fails, leave the file alone.
      }
    }

    for (const relPath of postStatus) {
      if (preSnapshot.has(relPath) || relPath === input.destination) {
        continue;
      }
      const abs = join(input.cwd, relPath);
      if (this.readTrackedHeadFile(input.cwd, relPath) !== undefined) {
        try {
          writeFileSync(abs, this.readTrackedHeadFile(input.cwd, relPath) ?? '');
        } catch {
          // leave it alone if the tracked restore fails
        }
      } else {
        try {
          rmSync(abs, { force: true, recursive: true });
        } catch {
          // leave it alone if the delete fails
        }
      }
    }
  }

  private async onlyDestinationChanged(
    cwd: string,
    destinationAbs: string,
    preSnapshot: Map<string, FileSnapshot>,
    postStatus: Set<string>,
  ): Promise<boolean> {
    for (const relPath of postStatus) {
      if (relPath === relative(cwd, destinationAbs).replace(/\\/g, '/')) {
        continue;
      }
      if (!preSnapshot.has(relPath)) {
        return false;
      }
      const abs = join(cwd, relPath);
      try {
        const current = readFileSync(abs, 'utf-8');
        if (current !== preSnapshot.get(relPath)!.contents) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  private async snapshotChangedPaths(
    cwd: string,
    destinationAbs: string,
  ): Promise<Map<string, FileSnapshot>> {
    const snapshot = new Map<string, FileSnapshot>();
    const paths = new Set<string>([relative(cwd, destinationAbs).replace(/\\/g, '/')]);
    for (const relPath of await this.safeStatusPaths(cwd)) {
      paths.add(relPath);
    }
    for (const relPath of paths) {
      const abs = join(cwd, relPath);
      if (!existsSync(abs)) continue;
      try {
        snapshot.set(relPath, { contents: readFileSync(abs, 'utf-8') });
      } catch {
        // Skip unreadable files.
      }
    }
    return snapshot;
  }

  private async safeStatusPaths(cwd: string): Promise<Set<string>> {
    try {
      const status = await this.git.status(cwd);
      return parseStatusPaths(status);
    } catch {
      return new Set();
    }
  }

  private async safeHeadCommitSha(cwd: string): Promise<string | undefined> {
    try {
      return await this.git.headCommitSha(cwd);
    } catch {
      return undefined;
    }
  }

  private matchesRawArtifact(destinationAbs: string, cappedRawArtifact: string): boolean {
    try {
      return readFileSync(destinationAbs, 'utf-8') === cappedRawArtifact;
    } catch {
      return false;
    }
  }

  private writePromptFile(prompt: string): string {
    const dir = join(tmpdir(), `structured-result-repair-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'prompt.md');
    writeFileSync(path, prompt);
    return path;
  }

  private readTrackedHeadFile(cwd: string, relPath: string): string | undefined {
    try {
      return execFileSync('git', ['show', `HEAD:${relPath}`], { cwd, encoding: 'utf-8' });
    } catch {
      return undefined;
    }
  }
}

function parseStatusPaths(status: string): Set<string> {
  const paths = new Set<string>();
  for (const line of status.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let path = line.slice(3).trim();
    if (!path) continue;
    const renameIdx = path.indexOf(' -> ');
    if (renameIdx !== -1) {
      path = path.slice(renameIdx + 4);
    }
    paths.add(path.replace(/\\/g, '/'));
  }
  return paths;
}

function resolvePathWithinCwd(cwd: string, destination: string): string | null {
  if (!destination.trim()) return null;
  const abs = resolve(cwd, destination);
  const rel = relative(cwd, abs);
  if (rel === '') return abs;
  if (rel === '.' || rel === '') return abs;
  if (rel.startsWith(`..${sep}`) || rel === '..') return null;
  return abs;
}

function capText(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.byteLength <= maxBytes) return text;
  return buf.subarray(buf.byteLength - maxBytes).toString('utf-8');
}

function defaultReadTailBytes(path: string): string {
  if (!path || !existsSync(path)) return '';
  const stat = statSync(path);
  if (stat.size === 0) return '';
  const bytesToRead = Math.min(stat.size, TAIL_MAX_BYTES);
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
    return buffer.toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

function removePromptFile(promptPath: string): void {
  try {
    rmSync(dirname(promptPath), { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

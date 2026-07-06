import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { AgentInvocationId, AgentProfileName } from '@ai-sdlc/domain';
import type {
  AgentPort,
  AgentInvocationRequest,
  ArtifactStore,
  EventBusPort,
  GitPort,
  SynthesizeFromTranscriptInput,
  SynthesizeFromTranscriptPort,
  SynthesizeFromTranscriptResult,
} from '@ai-sdlc/application/ports';
import { ArtifactNotFoundError } from '@ai-sdlc/application/ports';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

export const PROSE_ARTIFACT_ALLOWLIST: ReadonlySet<string> = new Set([
  'implementation-log.md',
  'compound.md',
]);

// Reused from the existing ImplementArtifactGuard policy.
const STATUS_REGEX = /^\s*(?:Status:\s*)?(DONE|DONE_WITH_CONCERNS)[.\s]*$/i;

const TAIL_MAX_BYTES = 8 * 1024;
const TAIL_MIN_BYTES = 200;
const TAIL_HEAD_LINES = 60;
const DIFF_SUMMARY_MAX_LINES = 500;

export interface BuildSynthesisPromptInput {
  artifactPath: string;
  tail: string;
  baseSha: string;
  headSha: string;
  gitLog: string;
  diffSummary: string;
  primaryInvocationId: string;
}

export function buildSynthesisPrompt(input: BuildSynthesisPromptInput): string {
  return [
    'You are a transcript-summarizer.',
    'The previous agent completed its work and committed it, but failed to write',
    `${input.artifactPath}.`,
    '',
    '## Verifiable state',
    `Base SHA: ${input.baseSha}`,
    `HEAD SHA: ${input.headSha}`,
    `Primary invocation id: ${input.primaryInvocationId}`,
    '',
    '### Git log (base -> HEAD)',
    input.gitLog,
    '',
    '### Diff summary (first 500 lines)',
    input.diffSummary,
    '',
    '## Transcript tail (agent completion summary)',
    '```',
    input.tail,
    '```',
    '',
    '## Your task',
    '1. Verify the transcript describes work consistent with the diff above.',
    `2. Write the cleaned summary to ./${input.artifactPath}:`,
    '   - Status line: "Status: DONE" or "Status: DONE_WITH_CONCERNS" or "Status: BLOCKED"',
    '   - 1-3 lines describing what changed,',
    '   - "Files changed:" section listing the same paths as the diff above.',
    '3. If the transcript contradicts the diff, write "Status: BLOCKED" with a one-line reason.',
    `Do NOT modify any code or any file other than ${input.artifactPath}.`,
  ].join('\n');
}

type ArtifactStoreForRun = (runId: string, cwd: string) => ArtifactStore;

export interface SynthesizeFromTranscriptOptions {
  artifacts: ArtifactStoreForRun;
  git: GitPort;
  agent: AgentPort;
  eventBus?: EventBusPort;
  proseAllowlist?: ReadonlySet<string>;
  resultWriterProfile?: string;
  promptBuilder?: (input: BuildSynthesisPromptInput) => string;
  idFactory?: () => string;
  readTailBytes?: (path: string) => string;
  clock?: () => Date;
}

export class SynthesizeFromTranscript implements SynthesizeFromTranscriptPort {
  private readonly artifacts: ArtifactStoreForRun;
  private readonly git: GitPort;
  private readonly agent: AgentPort;
  private readonly eventBus?: EventBusPort;
  private readonly proseAllowlist: ReadonlySet<string>;
  private readonly resultWriterProfile: string;
  private readonly promptBuilder: (input: BuildSynthesisPromptInput) => string;
  private readonly idFactory: () => string;
  private readonly readTailBytes: (path: string) => string;
  private readonly clock: () => Date;

  constructor(opts: SynthesizeFromTranscriptOptions) {
    this.artifacts = opts.artifacts;
    this.git = opts.git;
    this.agent = opts.agent;
    if (opts.eventBus) this.eventBus = opts.eventBus;
    this.proseAllowlist = opts.proseAllowlist ?? PROSE_ARTIFACT_ALLOWLIST;
    this.resultWriterProfile = opts.resultWriterProfile ?? 'task-reviewer';
    this.promptBuilder = opts.promptBuilder ?? buildSynthesisPrompt;
    this.idFactory = opts.idFactory ?? (() => randomUUID());
    this.readTailBytes = opts.readTailBytes ?? defaultReadTailBytes;
    this.clock = opts.clock ?? (() => new Date());
  }

  async synthesizeFromTranscript(
    input: SynthesizeFromTranscriptInput,
  ): Promise<SynthesizeFromTranscriptResult> {
    if (!this.proseAllowlist.has(input.missingArtifact)) {
      this.emitPolicyNotSatisfied(input, 'artifact_not_in_allowlist');
      return { outcome: 'no_policy_match' };
    }

    if (input.primaryExitCode !== 0) {
      this.emitPolicyNotSatisfied(input, 'primary_exit_nonzero');
      return { outcome: 'no_policy_match' };
    }

    if (input.workingTreeDirty) {
      this.emitPolicyNotSatisfied(input, 'working_tree_dirty');
      return { outcome: 'no_policy_match' };
    }

    if (input.endCommitSha === input.startCommitSha) {
      this.emitPolicyNotSatisfied(input, 'head_unchanged');
      return { outcome: 'no_policy_match' };
    }

    const artifacts = this.artifacts(input.runId, input.cwd);
    const already = await this.readIfPresent(artifacts, input.runId, input.missingArtifact);
    if (already && already.trim().length > 0) {
      return { outcome: 'no_policy_match' };
    }

    const tail = this.readTailBytes(input.primaryInvocation.stdoutPath);
    if (tail.length < TAIL_MIN_BYTES) {
      this.emitPolicyNotSatisfied(input, 'tail_too_short');
      return { outcome: 'no_policy_match' };
    }

    if (!hasSummaryMarkers(tail)) {
      this.emitPolicyNotSatisfied(input, 'no_summary_markers');
      return { outcome: 'no_policy_match' };
    }

    const headLines = tail.split(/\r?\n/).slice(-TAIL_HEAD_LINES).join('\n');
    const gitLog = await this.git
      .logBetween(input.cwd, input.startCommitSha, input.endCommitSha)
      .then((arr) => arr.join('\n'))
      .catch(() => '');
    const diffSummary = await this.git
      .diff(input.cwd, input.startCommitSha, input.endCommitSha)
      .then((d) => d.split(/\r?\n/).slice(0, DIFF_SUMMARY_MAX_LINES).join('\n'))
      .catch(() => '');

    const synthesisId = AgentInvocationId(this.idFactory());
    const prompt = this.promptBuilder({
      artifactPath: input.missingArtifact,
      tail: headLines,
      baseSha: input.startCommitSha,
      headSha: input.endCommitSha,
      gitLog,
      diffSummary,
      primaryInvocationId: String(input.primaryInvocation.id),
    });

    const request: AgentInvocationRequest = {
      profile: AgentProfileName(this.resultWriterProfile),
      promptPath: prompt,
      expectedArtifacts: [input.missingArtifact],
      cwd: input.cwd,
      runId: input.runId,
      repoId: input.cwd,
      phaseId: `${input.phaseId}.synthesize`,
      startCommitSha: input.endCommitSha,
      fallbackOfInvocationId: input.primaryInvocation.id,
      fallbackReason: 'synthesized_from_transcript',
    };

    let result;
    try {
      result = await this.agent.invoke(request);
    } catch (e) {
      await this.cleanupFailedSynthesis(input);
      this.emitSynthesisFailed(
        input,
        synthesisId,
        headLines.length,
        `agent_threw:${stringifyErr(e)}`,
      );
      return {
        outcome: 'synthesis_failed',
        synthesisInvocationId: synthesisId,
        tailBytes: headLines.length,
      };
    }

    if (result.outcome !== 'success' || result.exitCode !== 0) {
      await this.cleanupFailedSynthesis(input);
      this.emitSynthesisFailed(
        input,
        synthesisId,
        headLines.length,
        `agent_outcome:${result.outcome}`,
      );
      return {
        outcome: 'synthesis_failed',
        synthesisInvocationId: synthesisId,
        tailBytes: headLines.length,
      };
    }

    const written = await this.readIfPresent(artifacts, input.runId, input.missingArtifact);
    if (!written || written.trim().length === 0) {
      await this.cleanupFailedSynthesis(input);
      this.emitSynthesisFailed(
        input,
        synthesisId,
        headLines.length,
        'artifact_missing_after_invoke',
      );
      return {
        outcome: 'synthesis_failed',
        synthesisInvocationId: synthesisId,
        tailBytes: headLines.length,
      };
    }

    if (isBlockedArtifact(written)) {
      await this.cleanupFailedSynthesis(input);
      const firstLine = written.split(/\r?\n/, 1)[0] ?? '';
      this.emitSynthesisFailed(
        input,
        synthesisId,
        headLines.length,
        `writer_wrote_blocked: ${firstLine}`,
      );
      return {
        outcome: 'synthesis_failed',
        synthesisInvocationId: synthesisId,
        tailBytes: headLines.length,
      };
    }

    this.emitSynthesized(input, synthesisId, headLines.length);
    return {
      outcome: 'synthesized',
      synthesisInvocationId: synthesisId,
      tailBytes: headLines.length,
    };
  }

  private async cleanupFailedSynthesis(input: SynthesizeFromTranscriptInput): Promise<void> {
    try {
      await this.git.resetHard(input.cwd, input.endCommitSha);
      await this.git.cleanUntracked(input.cwd);
    } catch (e) {
      this.emit(
        input,
        'error',
        'artifact.synthesis_cleanup_failed',
        'failed to clean up working tree after synthesis failure',
        {
          phaseId: input.phaseId,
          stepIndex: input.stepIndex,
          artifact: input.missingArtifact,
          error: stringifyErr(e),
        },
      );
    }
  }

  private async readIfPresent(
    store: ArtifactStore,
    runId: string,
    relPath: string,
  ): Promise<string | undefined> {
    try {
      return await store.read(runId, relPath);
    } catch (e) {
      if (e instanceof ArtifactNotFoundError) return undefined;
      throw e;
    }
  }

  private emitPolicyNotSatisfied(input: SynthesizeFromTranscriptInput, reason: string): void {
    this.emit(
      input,
      'info',
      'artifact.synthesis_policy_not_satisfied',
      'synthesis policy not satisfied',
      {
        phaseId: input.phaseId,
        stepIndex: input.stepIndex,
        artifact: input.missingArtifact,
        reason,
      },
    );
  }

  private emitSynthesized(
    input: SynthesizeFromTranscriptInput,
    synthesisId: AgentInvocationId,
    tailBytes: number,
  ): void {
    this.emit(
      input,
      'warn',
      'artifact.synthesized_from_transcript',
      `synthesized ${input.missingArtifact} from transcript tail`,
      {
        phaseId: input.phaseId,
        stepIndex: input.stepIndex,
        artifact: input.missingArtifact,
        primaryInvocationId: String(input.primaryInvocation.id),
        synthesisInvocationId: String(synthesisId),
        tailBytes,
      },
    );
  }

  private emitSynthesisFailed(
    input: SynthesizeFromTranscriptInput,
    synthesisId: AgentInvocationId,
    tailBytes: number,
    reason: string,
  ): void {
    this.emit(input, 'warn', 'artifact.synthesis_failed', 'synthesis attempt failed', {
      phaseId: input.phaseId,
      stepIndex: input.stepIndex,
      artifact: input.missingArtifact,
      primaryInvocationId: String(input.primaryInvocation.id),
      synthesisInvocationId: String(synthesisId),
      tailBytes,
      reason,
    });
  }

  private emit(
    input: SynthesizeFromTranscriptInput,
    level: 'info' | 'warn' | 'error',
    type: string,
    message: string,
    metadata: Record<string, unknown>,
  ): void {
    if (!this.eventBus) return;
    const event: OrchestratorEvent = {
      runId: input.runId,
      level,
      type,
      message,
      timestamp: this.clock().toISOString(),
      metadata,
    };
    this.eventBus.publish(input.runId, event);
  }
}

function defaultReadTailBytes(path: string): string {
  if (!path) return '';
  if (!existsSync(path)) return '';
  const stat = statSync(path);
  if (stat.size === 0) return '';
  const bytesToRead = Math.min(stat.size, TAIL_MAX_BYTES);
  const fd = require('node:fs').openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    require('node:fs').readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
    return buffer.toString('utf-8');
  } finally {
    require('node:fs').closeSync(fd);
  }
}

function hasSummaryMarkers(tail: string): boolean {
  const lines = tail.split(/\r?\n/);
  const tailSlice = lines.slice(-TAIL_HEAD_LINES);
  if (tailSlice.some((line) => STATUS_REGEX.test(line))) return true;
  if (/Files changed:/i.test(tail)) return true;
  if (/\*\*Status:\*\*/i.test(tail)) return true;
  if (/^#{1,6}\s+[A-Z]/m.test(tail)) return true;
  return false;
}

function isBlockedArtifact(contents: string): boolean {
  const firstLine = contents.split(/\r?\n/, 1)[0] ?? '';
  return /^\s*Status:\s*BLOCKED/i.test(firstLine);
}

function stringifyErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

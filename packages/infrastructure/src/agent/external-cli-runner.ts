import { execa } from 'execa';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmdirSync,
  readdirSync,
  copyFileSync,
  unlinkSync,
} from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { join, dirname, basename, resolve, relative } from 'node:path';
import { type AgentRuntimeKind } from '@ai-sdlc/domain';
import { CONTRACT_VIOLATION_CODES } from '@ai-sdlc/application/ports';
import type { AgentInvocationResult } from '@ai-sdlc/application/ports';
import { testProviderErrorPatterns, testQuotaPatterns } from './error-patterns.js';

const NOISE_DIRS = new Set([
  'node_modules',
  '.next',
  '.cache',
  '.git',
  'dist',
  'build',
  '.turbo',
  '.nuxt',
  'coverage',
  '__pycache__',
  '.venv',
  'vendor',
  '.pytest_cache',
  '.mypy_cache',
  'target',
  'out',
  '.gradle',
]);

function findMisplacedCandidate(
  cwd: string,
  artifactBasename: string,
  excludePaths?: Set<string>,
): string | null {
  try {
    const candidates: string[] = [];
    function scan(dir: string, depth: number) {
      if (depth > 5) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // Skip this unreadable directory and continue
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (NOISE_DIRS.has(entry.name)) continue;
          scan(join(dir, entry.name), depth + 1);
        } else if (entry.isFile()) {
          if (depth >= 2 && entry.name === artifactBasename) {
            const relativePath = relative(cwd, join(dir, entry.name));
            const normalizedRelativePath = relativePath.replace(/\\/g, '/');
            if (excludePaths?.has(normalizedRelativePath)) {
              continue;
            }
            // skip git-tracked files (only untracked/ignored files are candidates)
            try {
              const gitPath = relativePath.replace(/\\/g, '/');
              execFileSync('git', ['ls-files', '--error-unmatch', '--', gitPath], {
                cwd,
                stdio: 'pipe',
              });
              // exit 0 means tracked → skip
              continue;
            } catch (err) {
              const errorWithStatus = err as { status?: number };
              if (errorWithStatus && errorWithStatus.status === 1) {
                // status 1 means command ran but file is not tracked → valid candidate
              } else {
                // any other error (ENOENT, exit code 128, etc.) → do not treat as untracked
                continue;
              }
            }
            candidates.push(relativePath);
          }
        }
      }
    }

    scan(cwd, 1);
    return candidates.length === 1 ? candidates[0]! : null;
  } catch {
    return null;
  }
}

function moveMisplacedArtifact(cwd: string, srcRelative: string, destRelative: string): void {
  const src = join(cwd, srcRelative);
  const dest = join(cwd, destRelative);
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
      copyFileSync(src, dest);
      unlinkSync(src);
    } else {
      throw e;
    }
  }
  // Clean up empty ancestor directories up to (but not including) cwd
  let dir = dirname(src);
  while (resolve(dir) !== resolve(cwd) && dir !== dirname(dir)) {
    try {
      rmdirSync(dir);
      dir = dirname(dir);
    } catch {
      break;
    }
  }
}

export interface ExternalCliRunInput {
  runtime: AgentRuntimeKind;
  bin: string;
  args: string[];
  input?: string;
  env?: Record<string, string>;
  cwd: string;
  artifactsDir: string;
  model: string;
  provider?: string;
  timeoutMsDefault?: number;
  abortSignal?: AbortSignal;
  forceKillAfterDelayMs?: number;
  detached?: boolean;
  startCommitSha?: string;
  expectedArtifacts?: string[];
}

export async function runExternalCli(input: ExternalCliRunInput): Promise<AgentInvocationResult> {
  const invocationDir = join(
    input.artifactsDir,
    `inv-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(invocationDir, { recursive: true });
  const stdoutPath = join(invocationDir, 'stdout.log');
  const stderrPath = join(invocationDir, 'stderr.log');

  const start = Date.now();
  let outcome: AgentInvocationResult['outcome'] = 'success';
  let exitCode = 0;
  let stdout = '';
  let stderr = '';
  let contractViolations: string[] = [];

  const timeoutSignal =
    input.timeoutMsDefault !== undefined ? AbortSignal.timeout(input.timeoutMsDefault) : undefined;
  const signals: AbortSignal[] = [];
  if (timeoutSignal) signals.push(timeoutSignal);
  if (input.abortSignal) signals.push(input.abortSignal);
  const cancelSignal =
    signals.length === 1 ? signals[0] : signals.length > 1 ? AbortSignal.any(signals) : undefined;

  const child = execa(input.bin, input.args, {
    cwd: input.cwd,
    reject: false,
    all: false,
    detached: input.detached ?? false,
    ...(input.input !== undefined ? { input: input.input } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(cancelSignal ? { cancelSignal } : {}),
    forceKillAfterDelay: input.forceKillAfterDelayMs ?? 5_000,
  });

  // Send SIGTERM to the process group on cancel/abort while the PID is still
  // provably alive (avoids the PID-reuse race in finally). SIGKILL escalation
  // is handled by execa's forceKillAfterDelay after the grace period.
  // Must remove the listener once the child settles — if the child exits before
  // the timeout fires, the listener persists on AbortSignal.timeout() (held by
  // Node.js internally) and could signal a recycled PID group.
  const onAbort = () => {
    if (input.detached) {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        // ESRCH = already dead, ignore
      }
    }
  };
  cancelSignal?.addEventListener('abort', onAbort);

  let stderrForLog = stderr;
  try {
    const r = await child;
    stdout = r.stdout ?? '';
    stderr = r.stderr ?? '';
    stderrForLog = stderr;
    exitCode = r.exitCode ?? 0;
    if (r.isCanceled) {
      if (timeoutSignal?.aborted && !input.abortSignal?.aborted) {
        outcome = 'timeout';
      } else {
        outcome = 'failed';
        contractViolations = [CONTRACT_VIOLATION_CODES.CANCELLED_BY_ORCHESTRATOR];
      }
    } else if (exitCode !== 0) {
      outcome = 'failed';
      const providerMatch = testProviderErrorPatterns(stderr, { maxLines: 200 });
      if (providerMatch) {
        contractViolations = [CONTRACT_VIOLATION_CODES.PROVIDER_ERROR];
        const quotaLine = testQuotaPatterns(stderr, { maxLines: 200 });
        if (quotaLine) {
          stderrForLog = `QUOTA_EXCEEDED: ${quotaLine}\n${stderrForLog}`;
        } else {
          stderrForLog = `PROVIDER_ERROR: ${providerMatch}\n${stderrForLog}`;
        }
      }
    } else if (outcome === 'success') {
      const providerMatch = testProviderErrorPatterns(stderr, { maxLines: 200 });
      if (providerMatch) {
        outcome = 'failed';
        contractViolations = [CONTRACT_VIOLATION_CODES.PROVIDER_ERROR];
        const quotaLine = testQuotaPatterns(stderr, { maxLines: 200 });
        if (quotaLine) {
          stderr = `QUOTA_EXCEEDED: ${quotaLine}`;
          stderrForLog = `QUOTA_EXCEEDED: ${quotaLine}\n${stderrForLog}`;
        } else {
          stderr = `PROVIDER_ERROR: ${providerMatch}`;
          stderrForLog = `PROVIDER_ERROR: ${providerMatch}\n${stderrForLog}`;
        }
      }
    }
  } catch (e) {
    outcome = 'failed';
    exitCode = 1;
    stderr = String((e as Error).message);
    stderrForLog = stderr;
  } finally {
    cancelSignal?.removeEventListener('abort', onAbort);
    // Safety net: only meaningful for detached children (process-group leaders).
    // Non-detached children are not PGIDs, so kill(-pid) would be ESRCH or
    // worse, could hit a recycled PID's group. Guard with input.detached.
    if (outcome !== 'success' && input.detached) {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
      }
    }
  }
  writeFileSync(stdoutPath, stdout);
  writeFileSync(stderrPath, stderrForLog);

  const durationMs = Date.now() - start;
  let endCommitSha: string | undefined;
  try {
    endCommitSha = execSync('git rev-parse HEAD', { cwd: input.cwd }).toString().trim();
  } catch {
    contractViolations = [...contractViolations, CONTRACT_VIOLATION_CODES.MISSING_COMMIT];
  }

  let remediatedArtifacts: { src: string; artifact: string }[] | undefined;

  if (
    outcome === 'success' &&
    !contractViolations.length &&
    input.startCommitSha &&
    endCommitSha === input.startCommitSha &&
    !stdout.trim() &&
    !stderr.trim() &&
    !input.expectedArtifacts?.length
  ) {
    outcome = 'contract_violation';
    contractViolations = [CONTRACT_VIOLATION_CODES.NO_OUTPUT];
    stderrForLog = `NO_OUTPUT: agent exited 0 with empty stdout and no git changes\n${stderrForLog}`;
    writeFileSync(stderrPath, stderrForLog);
  }

  if (outcome === 'success' && input.expectedArtifacts?.length) {
    for (const artifact of input.expectedArtifacts) {
      const artifactPath = join(input.cwd, artifact);
      if (!existsSync(artifactPath)) {
        outcome = 'contract_violation';
        contractViolations = [
          ...contractViolations,
          CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT,
        ];
        stderrForLog = `MISSING_REQUIRED_ARTIFACT: ${artifact}\n${stderrForLog}`;
        writeFileSync(stderrPath, stderrForLog);
        break;
      }
    }
  }

  // Post-check remediation: if MISSING_REQUIRED_ARTIFACT was set, try to find
  // each missing artifact anywhere in the worktree by exact basename match.
  if (
    outcome === 'contract_violation' &&
    contractViolations.includes(CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT) &&
    input.expectedArtifacts?.length
  ) {
    const excludePaths = new Set<string>();
    for (const artifact of input.expectedArtifacts) {
      if (existsSync(join(input.cwd, artifact))) {
        excludePaths.add(artifact.replace(/\\/g, '/'));
      }
    }

    for (const artifact of input.expectedArtifacts) {
      if (existsSync(join(input.cwd, artifact))) continue;
      const artifactBasename = basename(artifact);
      const candidate = findMisplacedCandidate(input.cwd, artifactBasename, excludePaths);
      if (!candidate) continue;
      try {
        moveMisplacedArtifact(input.cwd, candidate, artifact);
        remediatedArtifacts = [...(remediatedArtifacts ?? []), { src: candidate, artifact }];
        excludePaths.add(artifact.replace(/\\/g, '/'));
      } catch (e) {
        console.warn('moveMisplacedArtifact failed:', e);
      }
    }
    // If all expected artifacts are now present, swap violation codes and restore outcome.
    if (remediatedArtifacts?.length) {
      const allPresent = input.expectedArtifacts.every((a) => existsSync(join(input.cwd, a)));
      if (allPresent) {
        outcome = 'success';
        contractViolations = contractViolations
          .filter((v) => v !== CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT)
          .concat(CONTRACT_VIOLATION_CODES.MISPLACED_ARTIFACT);
        const remediatedList = remediatedArtifacts
          .map((r) => `${r.src} → ${r.artifact}`)
          .join(', ');
        stderrForLog = `MISPLACED_ARTIFACT: auto-remediated ${remediatedList}\n${stderrForLog}`;
        writeFileSync(stderrPath, stderrForLog);
      }
    }
  }

  const ret: AgentInvocationResult = {
    runtime: input.runtime,
    provider: input.provider ?? '',
    model: input.model,
    exitCode,
    durationMs,
    stdoutPath,
    stderrPath,
    contractViolations,
    outcome,
  };
  if (endCommitSha) ret.endCommitSha = endCommitSha;
  if (remediatedArtifacts) ret.remediatedArtifacts = remediatedArtifacts;
  if (outcome === 'success' && input.expectedArtifacts?.includes('result.json')) {
    ret.resultJsonPath = 'result.json';
  }
  return ret;
}

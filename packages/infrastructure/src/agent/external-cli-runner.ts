import { execa } from 'execa';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { type AgentRuntimeKind } from '@ai-sdlc/domain';
import { CONTRACT_VIOLATION_CODES } from '@ai-sdlc/application/ports';
import type { AgentInvocationResult } from '@ai-sdlc/application/ports';

export interface ExternalCliRunInput {
  runtime: AgentRuntimeKind;
  bin: string;
  args: string[];
  input?: string;
  cwd: string;
  artifactsDir: string;
  model: string;
  provider?: string;
  timeoutMsDefault?: number;
  abortSignal?: AbortSignal;
  forceKillAfterDelayMs?: number;
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
    detached: true,
    ...(input.input !== undefined ? { input: input.input } : {}),
    ...(cancelSignal ? { cancelSignal } : {}),
    forceKillAfterDelay: input.forceKillAfterDelayMs ?? 5_000,
  });
  try {
    const r = await child;
    stdout = r.stdout ?? '';
    stderr = r.stderr ?? '';
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
    }
  } catch (e) {
    outcome = 'failed';
    exitCode = 1;
    stderr = String((e as Error).message);
  } finally {
    if (outcome !== 'success') {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // ESRCH = process already dead, ignore
      }
    }
  }
  writeFileSync(stdoutPath, stdout);
  writeFileSync(stderrPath, stderr);

  const durationMs = Date.now() - start;
  let endCommitSha: string | undefined;
  try {
    endCommitSha = execSync('git rev-parse HEAD', { cwd: input.cwd }).toString().trim();
  } catch {
    contractViolations = [...contractViolations, CONTRACT_VIOLATION_CODES.MISSING_COMMIT];
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
  return ret;
}

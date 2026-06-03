import { execa } from 'execa';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { testQuotaPatterns, testProviderErrorPatterns } from './error-patterns.js';
import { CONTRACT_VIOLATION_CODES } from '@ai-sdlc/application/ports';
import type { AgentPort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';

export interface OpenCodeAdapterOptions {
  binaryPath?: string;
  artifactsDir: string;
  timeoutMsDefault?: number;
  sessionLogDir?: string;
  quotaPollMs?: number;
}

export class OpenCodeAgentAdapter implements AgentPort {
  constructor(private readonly opts: OpenCodeAdapterOptions) {}

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    let watchdogKilled = false;
    let watchdogMatch = '';

    const bin = this.opts.binaryPath ?? 'opencode';
    const invocationDir = join(
      this.opts.artifactsDir,
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
    let watchdogInterval: NodeJS.Timeout | null = null;
    let timeoutSignal: AbortSignal | undefined;
    let isCanceled = false;
    try {
      timeoutSignal =
        this.opts.timeoutMsDefault !== undefined
          ? AbortSignal.timeout(this.opts.timeoutMsDefault)
          : undefined;
      const signals: AbortSignal[] = [];
      if (timeoutSignal) signals.push(timeoutSignal);
      if (request.abortSignal) signals.push(request.abortSignal);
      const cancelSignal =
        signals.length === 1
          ? signals[0]
          : signals.length > 1
            ? AbortSignal.any(signals)
            : undefined;
      const args = ['run'];
      if (request.model) {
        // opencode's --model expects "provider/model". The router supplies
        // both from the profile; the model field must be the bare model name
        // (no provider prefix) — config is responsible for that contract.
        const modelArg = request.provider ? `${request.provider}/${request.model}` : request.model;
        args.push('--model', modelArg);
      }
      const child = execa(bin, args, {
        cwd: request.cwd,
        reject: false,
        all: false,
        input: readFileSync(request.promptPath, 'utf-8'),
        ...(cancelSignal ? { cancelSignal } : {}),
      });

      watchdogInterval = this.startWatchdog(
        child as ReturnType<typeof execa>,
        start,
        (match: string) => {
          watchdogKilled = true;
          watchdogMatch = match;
        },
      );

      const r = await child;
      if (watchdogInterval !== null) clearInterval(watchdogInterval);

      stdout = r.stdout ?? '';
      stderr = r.stderr ?? '';
      exitCode = r.exitCode ?? 0;
      isCanceled = r.isCanceled;
    } catch (e) {
      if (watchdogInterval !== null) clearInterval(watchdogInterval);
      outcome = 'failed';
      exitCode = 1;
      stderr = String((e as Error).message);
    }

    const durationMs = Date.now() - start;
    let endCommitSha: string | undefined;
    try {
      endCommitSha = execSync('git rev-parse HEAD', { cwd: request.cwd }).toString().trim();
    } catch {
      contractViolations = [...contractViolations, 'missing_commit'];
    }

    let stderrForLog = stderr;
    if (watchdogKilled) {
      outcome = 'failed';
      stderr = `QUOTA_EXCEEDED: ${watchdogMatch}`;
      stderrForLog = `QUOTA_EXCEEDED: ${watchdogMatch}\n${stderrForLog}`;
    } else if (isCanceled) {
      if (timeoutSignal?.aborted && !request.abortSignal?.aborted) {
        outcome = 'timeout';
      } else {
        outcome = 'failed';
        contractViolations = [CONTRACT_VIOLATION_CODES.CANCELLED_BY_ORCHESTRATOR];
      }
    } else if (exitCode !== 0) {
      outcome = 'failed';
    } else if (outcome === 'success') {
      const combinedOutput = `${stdout}\n${stderr}`;
      const providerMatch = testProviderErrorPatterns(combinedOutput);
      if (providerMatch) {
        outcome = 'failed';
        contractViolations = [CONTRACT_VIOLATION_CODES.PROVIDER_ERROR];
        const quotaLine = testQuotaPatterns(combinedOutput);
        if (quotaLine) {
          stderr = `QUOTA_EXCEEDED: ${quotaLine}`;
          stderrForLog = `QUOTA_EXCEEDED: ${quotaLine}\n${stderrForLog}`;
        } else {
          stderr = `PROVIDER_ERROR: ${providerMatch}`;
          stderrForLog = `PROVIDER_ERROR: ${providerMatch}\n${stderrForLog}`;
        }
      } else if (
        request.phaseId === 'implement' &&
        request.startCommitSha &&
        endCommitSha === request.startCommitSha &&
        stdout.trim().length === 0
      ) {
        outcome = 'failed';
        contractViolations = [CONTRACT_VIOLATION_CODES.NO_OUTPUT];
        stderr = 'NO_OUTPUT: agent exited 0 with empty stdout and no git changes';
        stderrForLog = `NO_OUTPUT: agent exited 0 with empty stdout and no git changes\n${stderrForLog}`;
      }
    }
    writeFileSync(stdoutPath, stdout);
    writeFileSync(stderrPath, stderrForLog);

    const ret: AgentInvocationResult = {
      runtime: 'opencode',
      provider: '',
      model: request.model ?? '',
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

  private startWatchdog(
    child: ReturnType<typeof execa>,
    startTime: number,
    onQuota: (match: string) => void,
  ): NodeJS.Timeout | null {
    const sessionLogDir =
      this.opts.sessionLogDir ?? join(homedir(), '.local', 'share', 'opencode', 'log');

    try {
      if (!statSync(sessionLogDir).isDirectory()) return null;
    } catch {
      return null;
    }

    const pollMs = this.opts.quotaPollMs ?? 2000;
    const logOffsets = new Map<string, number>();
    const startTimeSec = startTime / 1000;

    return setInterval(() => {
      try {
        const files = readdirSync(sessionLogDir).filter((f) => f.endsWith('.log'));
        if (files.length === 0) return;

        for (const f of files) {
          const mtime = statSync(join(sessionLogDir, f)).mtimeMs / 1000;
          if (mtime < startTimeSec) continue;

          const logPath = join(sessionLogDir, f);
          const prevOffset = logOffsets.get(logPath) ?? 0;
          const size = statSync(logPath).size;
          if (size <= prevOffset) continue;

          const content = readFileSync(logPath, 'utf-8');
          const newContent = content.slice(prevOffset);
          logOffsets.set(logPath, content.length);

          const match = testQuotaPatterns(newContent);
          if (match) {
            onQuota(match);
            child.kill('SIGKILL');
            return;
          }
        }
      } catch {
        // File might be deleted between stat and read — ignore
      }
    }, pollMs);
  }
}

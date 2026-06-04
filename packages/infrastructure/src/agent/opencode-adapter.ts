import { execa } from 'execa';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { testQuotaPatterns, testProviderErrorPatterns } from './error-patterns.js';
import { CONTRACT_VIOLATION_CODES } from '@ai-sdlc/application/ports';
import type { AgentPort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';

export interface OpenCodeAdapterOptions {
  binaryPath?: string;
  artifactsDir: string;
  timeoutMsDefault?: number;
  quotaPollMs?: number;
}

export class OpenCodeAgentAdapter implements AgentPort {
  constructor(private readonly opts: OpenCodeAdapterOptions) {}

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    let watchdogKilled = false;
    let watchdogKilledType: 'quota' | 'provider' | null = null;
    let watchdogMatch = '';

    const bin = this.opts.binaryPath ?? 'opencode';
    const invocationDir = join(
      this.opts.artifactsDir,
      `inv-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(invocationDir, { recursive: true });
    const stdoutPath = join(invocationDir, 'stdout.log');
    const stderrPath = join(invocationDir, 'stderr.log');
    const sessionLogDir = join(invocationDir, 'session-log');
    mkdirSync(sessionLogDir, { recursive: true });

    const start = Date.now();
    let outcome: AgentInvocationResult['outcome'] = 'success';
    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    let contractViolations: string[] = [];
    let watchdogInterval: NodeJS.Timeout | null = null;
    let timeoutSignal: AbortSignal | undefined;
    let isCanceled = false;
    let postExit: { quotaMatch: string | null; providerMatch: string | null } | null = null;
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
        const modelArg = request.provider ? `${request.provider}/${request.model}` : request.model;
        args.push('--model', modelArg);
      }
      const childEnv: Record<string, string> = {
        OPENCODE_SESSION_LOG_DIR: sessionLogDir,
      };
      const child = execa(bin, args, {
        cwd: request.cwd,
        reject: false,
        all: false,
        input: readFileSync(request.promptPath, 'utf-8'),
        ...(cancelSignal ? { cancelSignal } : {}),
        env: childEnv,
      });

      watchdogInterval = this.startWatchdog(
        child as ReturnType<typeof execa>,
        sessionLogDir,
        (match: string, type: 'quota' | 'provider') => {
          watchdogKilled = true;
          watchdogKilledType = type;
          watchdogMatch = match;
        },
      );

      const r = await child;
      if (watchdogInterval !== null) clearInterval(watchdogInterval);

      postExit = this.scanSessionLogsPostExit(sessionLogDir);

      stdout = r.stdout ?? '';
      stderr = r.stderr ?? '';
      exitCode = r.exitCode ?? 0;
      isCanceled = r.isCanceled;

      if (!watchdogKilled && postExit.quotaMatch) {
        watchdogKilled = true;
        watchdogKilledType = 'quota';
        watchdogMatch = postExit.quotaMatch;
      }
      if (!watchdogKilled && watchdogKilledType === null && postExit.providerMatch) {
        watchdogKilled = true;
        watchdogKilledType = 'provider';
        watchdogMatch = postExit.providerMatch;
      }
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
      if (watchdogKilledType === 'quota') {
        contractViolations = [CONTRACT_VIOLATION_CODES.PROVIDER_ERROR];
        stderr = `QUOTA_EXCEEDED: ${watchdogMatch}`;
        stderrForLog = `QUOTA_EXCEEDED: ${watchdogMatch}\n${stderrForLog}`;
      } else {
        contractViolations = [CONTRACT_VIOLATION_CODES.PROVIDER_ERROR];
        const quotaLine = testQuotaPatterns(watchdogMatch);
        if (quotaLine) {
          stderr = `QUOTA_EXCEEDED: ${quotaLine}`;
          stderrForLog = `QUOTA_EXCEEDED: ${quotaLine}\n${stderrForLog}`;
        } else {
          stderr = `PROVIDER_ERROR: ${watchdogMatch}`;
          stderrForLog = `PROVIDER_ERROR: ${watchdogMatch}\n${stderrForLog}`;
        }
      }
    } else if (isCanceled) {
      if (timeoutSignal?.aborted && !request.abortSignal?.aborted) {
        outcome = 'timeout';
      } else {
        outcome = 'failed';
        contractViolations = [CONTRACT_VIOLATION_CODES.CANCELLED_BY_ORCHESTRATOR];
      }
    } else if (exitCode !== 0) {
      outcome = 'failed';
      const stderrProviderMatch = testProviderErrorPatterns(stderr);
      const postExitProviderMatch = postExit?.providerMatch ?? null;
      const providerMatch = stderrProviderMatch || postExitProviderMatch;
      if (providerMatch) {
        contractViolations = [CONTRACT_VIOLATION_CODES.PROVIDER_ERROR];
        const stderrQuotaLine = testQuotaPatterns(stderr);
        const postExitQuotaLine = postExitProviderMatch && testQuotaPatterns(postExitProviderMatch);
        const quotaLine = stderrQuotaLine || postExitQuotaLine;
        if (quotaLine) {
          stderrForLog = `QUOTA_EXCEEDED: ${quotaLine}\n${stderrForLog}`;
        } else {
          stderrForLog = `PROVIDER_ERROR: ${providerMatch}\n${stderrForLog}`;
        }
      }
    } else if (outcome === 'success') {
      const postExitProvider = !watchdogKilled && postExit ? postExit.providerMatch : null;
      const providerMatch = testProviderErrorPatterns(stderr) || postExitProvider;
      if (providerMatch) {
        outcome = 'failed';
        contractViolations = [CONTRACT_VIOLATION_CODES.PROVIDER_ERROR];
        const quotaLine = testQuotaPatterns(stderr) || testQuotaPatterns(providerMatch);
        if (quotaLine) {
          stderr = `QUOTA_EXCEEDED: ${quotaLine}`;
          stderrForLog = `QUOTA_EXCEEDED: ${quotaLine}\n${stderrForLog}`;
        } else {
          stderr = `PROVIDER_ERROR: ${providerMatch}`;
          stderrForLog = `PROVIDER_ERROR: ${providerMatch}\n${stderrForLog}`;
        }
      } else if (
        request.phaseId.startsWith('implement') &&
        request.startCommitSha &&
        endCommitSha === request.startCommitSha &&
        stdout.trim().length === 0
      ) {
        outcome = 'contract_violation';
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

  private scanSessionLogsPostExit(sessionLogDir: string): {
    quotaMatch: string | null;
    providerMatch: string | null;
  } {
    try {
      if (!statSync(sessionLogDir).isDirectory()) return { quotaMatch: null, providerMatch: null };
    } catch {
      return { quotaMatch: null, providerMatch: null };
    }

    let quotaMatch: string | null = null;
    let providerMatch: string | null = null;

    try {
      const files = readdirSync(sessionLogDir).filter((f) => f.endsWith('.log'));
      for (const f of files) {
        const logPath = join(sessionLogDir, f);
        const buf = readFileSync(logPath);
        const newContent = buf.toString('utf-8');
        if (!newContent) continue;
        if (!quotaMatch) {
          quotaMatch = testQuotaPatterns(newContent, { structuralOnly: true });
        }
        if (!providerMatch) {
          providerMatch = testProviderErrorPatterns(newContent, { structuralOnly: true });
        }
        if (quotaMatch && providerMatch) break;
      }
    } catch {
      // File might be deleted between stat and read — ignore
    }

    return { quotaMatch, providerMatch };
  }

  private startWatchdog(
    child: ReturnType<typeof execa>,
    sessionLogDir: string,
    onKilled: (match: string, type: 'quota' | 'provider') => void,
  ): NodeJS.Timeout | null {
    try {
      if (!statSync(sessionLogDir).isDirectory()) return null;
    } catch {
      return null;
    }

    const pollMs = this.opts.quotaPollMs ?? 2000;
    const logOffsets = new Map<string, number>();

    return setInterval(() => {
      try {
        const files = readdirSync(sessionLogDir).filter((f) => f.endsWith('.log'));
        if (files.length === 0) return;

        for (const f of files) {
          const logPath = join(sessionLogDir, f);

          const prevOffset = logOffsets.get(logPath) ?? 0;
          const size = statSync(logPath).size;
          if (size <= prevOffset) continue;

          const buf = readFileSync(logPath);
          const newContent = buf.subarray(prevOffset).toString('utf-8');
          logOffsets.set(logPath, buf.length);

          const quotaMatch = testQuotaPatterns(newContent, { structuralOnly: true });
          if (quotaMatch) {
            onKilled(quotaMatch, 'quota');
            child.kill('SIGKILL');
            return;
          }
          const providerMatch = testProviderErrorPatterns(newContent, { structuralOnly: true });
          if (providerMatch) {
            onKilled(providerMatch, 'provider');
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

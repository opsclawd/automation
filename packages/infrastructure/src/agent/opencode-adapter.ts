import { execa } from 'execa';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { testQuotaPatterns } from './quota-patterns.js';
import {
  type AgentPort,
  type AgentInvocationRequest,
  type AgentInvocationResult,
} from '@ai-sdlc/application';

export interface OpenCodeAdapterOptions {
  binaryPath?: string;
  artifactsDir: string;
  timeoutMsDefault?: number;
  sessionLogDir?: string;
  quotaPollMs?: number;
}

export class OpenCodeAgentAdapter implements AgentPort {
  private watchdogKilled = false;
  private watchdogMatch = '';

  constructor(private readonly opts: OpenCodeAdapterOptions) {}

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    this.watchdogKilled = false;
    this.watchdogMatch = '';

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
    try {
      const timeoutSignal =
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
      const child = execa(bin, args, {
        cwd: request.cwd,
        reject: false,
        all: false,
        input: readFileSync(request.promptPath, 'utf-8'),
        ...(cancelSignal ? { cancelSignal } : {}),
      });

      watchdogInterval = this.startWatchdog(child as ReturnType<typeof execa>, start);

      const r = await child;
      if (watchdogInterval !== null) clearInterval(watchdogInterval);

      stdout = r.stdout ?? '';
      stderr = r.stderr ?? '';
      exitCode = r.exitCode ?? 0;
      if (this.watchdogKilled) {
        outcome = 'failed';
        stderr = `QUOTA_EXCEEDED: ${this.watchdogMatch}`;
      } else if (r.isCanceled) {
        if (timeoutSignal?.aborted && !request.abortSignal?.aborted) {
          outcome = 'timeout';
        } else {
          outcome = 'failed';
          contractViolations = ['cancelled_by_orchestrator'];
        }
      } else if (exitCode !== 0) {
        outcome = 'failed';
      }
    } catch (e) {
      if (watchdogInterval !== null) clearInterval(watchdogInterval);
      outcome = 'failed';
      exitCode = 1;
      stderr = String((e as Error).message);
    }
    writeFileSync(stdoutPath, stdout);
    writeFileSync(stderrPath, stderr);

    const durationMs = Date.now() - start;
    let endCommitSha: string | undefined;
    try {
      endCommitSha = execSync('git rev-parse HEAD', { cwd: request.cwd }).toString().trim();
    } catch {
      contractViolations = [...contractViolations, 'missing_commit'];
    }

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

  private startWatchdog(child: ReturnType<typeof execa>, startTime: number): NodeJS.Timeout | null {
    const sessionLogDir = this.opts.sessionLogDir;
    if (!sessionLogDir) return null;

    try {
      if (!statSync(sessionLogDir).isDirectory()) return null;
    } catch {
      return null;
    }

    const pollMs = this.opts.quotaPollMs ?? 2000;
    let lastOffset = 0;
    const startTimeSec = startTime / 1000;

    return setInterval(() => {
      try {
        const files = readdirSync(sessionLogDir).filter((f) => f.endsWith('.log'));
        if (files.length === 0) return;

        let latest = '';
        let latestMtime = 0;
        for (const f of files) {
          const mtime = statSync(join(sessionLogDir, f)).mtimeMs / 1000;
          if (mtime >= startTimeSec && mtime > latestMtime) {
            latestMtime = mtime;
            latest = f;
          }
        }
        if (!latest) return;

        const logPath = join(sessionLogDir, latest);
        const size = statSync(logPath).size;
        if (size <= lastOffset) return;

        const content = readFileSync(logPath, 'utf-8');
        const newContent = content.slice(lastOffset);
        lastOffset = content.length;

        const match = testQuotaPatterns(newContent);
        if (match) {
          this.watchdogMatch = match;
          this.watchdogKilled = true;
          child.kill('SIGKILL');
        }
      } catch {
        // File might be deleted between stat and read — ignore
      }
    }, pollMs);
  }
}

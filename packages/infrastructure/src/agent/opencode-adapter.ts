import { execa } from 'execa';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import {
  type AgentPort,
  type AgentInvocationRequest,
  type AgentInvocationResult,
} from '@ai-sdlc/application';

export interface OpenCodeAdapterOptions {
  binaryPath?: string;
  artifactsDir: string;
  timeoutMsDefault?: number;
}

export class OpenCodeAgentAdapter implements AgentPort {
  constructor(private readonly opts: OpenCodeAdapterOptions) {}

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
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
      const r = await child;
      stdout = r.stdout ?? '';
      stderr = r.stderr ?? '';
      exitCode = r.exitCode ?? 0;
      if (r.isCanceled) {
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
}

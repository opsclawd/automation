import { execa } from 'execa';
import { mkdirSync, writeFileSync } from 'node:fs';
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
    try {
      const child = execa(bin, ['run', '--prompt-file', request.promptPath], {
        cwd: request.cwd,
        reject: false,
        all: false,
        ...(this.opts.timeoutMsDefault !== undefined
          ? { timeout: this.opts.timeoutMsDefault }
          : {}),
      });
      const r = await child;
      stdout = r.stdout ?? '';
      stderr = r.stderr ?? '';
      exitCode = r.exitCode ?? 0;
      if (r.timedOut) outcome = 'timeout';
      else if (exitCode !== 0) outcome = 'failed';
    } catch (e) {
      outcome = 'failed';
      exitCode = 1;
      stderr = String((e as Error).message);
    }
    writeFileSync(stdoutPath, stdout);
    writeFileSync(stderrPath, stderr);

    const durationMs = Date.now() - start;

    return {
      runtime: 'opencode',
      provider: '',
      model: '',
      exitCode,
      durationMs,
      stdoutPath,
      stderrPath,
      contractViolations: [],
      outcome,
    };
  }
}

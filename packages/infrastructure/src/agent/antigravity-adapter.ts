import { readFileSync } from 'node:fs';
import type { AgentPort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
import { runExternalCli } from './external-cli-runner.js';

export interface AntigravityAdapterOptions {
  binaryPath?: string;
  artifactsDir: string;
  timeoutMsDefault?: number;
  skipPermissions?: boolean;
}

export class AntigravityAgentAdapter implements AgentPort {
  constructor(private readonly opts: AntigravityAdapterOptions) {}

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    const bin = this.opts.binaryPath ?? 'agy';
    const prompt = readFileSync(request.promptPath, 'utf-8');

    const args: string[] = [];
    if (this.opts.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }
    args.push('--print', prompt);
    return runExternalCli({
      runtime: 'antigravity',
      bin,
      args,
      input: prompt,
      detached: true,
      cwd: request.cwd,
      artifactsDir: this.opts.artifactsDir,
      model: request.model ?? '',
      ...(request.provider !== undefined ? { provider: request.provider } : {}),
      ...(this.opts.timeoutMsDefault !== undefined
        ? { timeoutMsDefault: this.opts.timeoutMsDefault }
        : {}),
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
    });
  }
}

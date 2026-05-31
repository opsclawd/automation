import { readFileSync } from 'node:fs';
import type { AgentPort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
import { runExternalCli } from './external-cli-runner.js';

export interface ClaudeCodeAdapterOptions {
  binaryPath?: string;
  artifactsDir: string;
  timeoutMsDefault?: number;
}

export class ClaudeCodeAgentAdapter implements AgentPort {
  constructor(private readonly opts: ClaudeCodeAdapterOptions) {}

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    const bin = this.opts.binaryPath ?? 'claude';
    const prompt = readFileSync(request.promptPath, 'utf-8');
    const args = ['-p', '--permission-mode', 'plan', '--output-format', 'text'];
    if (request.model && request.model !== 'default') {
      args.push('--model', request.model);
    }
    return runExternalCli({
      runtime: 'claude-code',
      bin,
      args,
      input: prompt,
      cwd: request.cwd,
      artifactsDir: this.opts.artifactsDir,
      model: request.model ?? '',
      ...(this.opts.timeoutMsDefault !== undefined
        ? { timeoutMsDefault: this.opts.timeoutMsDefault }
        : {}),
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
    });
  }
}

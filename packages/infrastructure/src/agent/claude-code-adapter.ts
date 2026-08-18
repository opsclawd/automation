import { readFileSync } from 'node:fs';
import type { AgentPort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
import { runExternalCli } from './external-cli-runner.js';
import { extractTokenUsageFromText } from './usage-parser.js';

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
    const args = ['-p', '--permission-mode', 'bypassPermissions', '--output-format', 'text'];
    if (request.model && request.model !== 'default') {
      args.push('--model', request.model);
    }
    const result = await runExternalCli({
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
      startCommitSha: request.startCommitSha,
      expectedArtifacts: request.expectedArtifacts,
    });

    // Extract token usage from stdout/stderr transcripts (including cache-read tokens if reported)
    try {
      const stdoutContent = readFileSync(result.stdoutPath, 'utf-8');
      const stderrContent = readFileSync(result.stderrPath, 'utf-8');
      const usage =
        extractTokenUsageFromText(stdoutContent, {
          runtime: 'claude-code',
          logPath: result.stdoutPath,
        }) ??
        extractTokenUsageFromText(stderrContent, {
          runtime: 'claude-code',
          logPath: result.stderrPath,
        });

      if (usage) {
        result.usage = usage;
      } else {
        console.warn(
          `[claude-code] Usage was unavailable for invocation, recording explicit unknown usage: ${result.stdoutPath}`,
        );
        result.usage = { inputTokens: 0, outputTokens: 0 };
      }
    } catch {
      result.usage = { inputTokens: 0, outputTokens: 0 };
    }

    return result;
  }
}

import { readFileSync, writeFileSync } from 'node:fs';
import { CONTRACT_VIOLATION_CODES } from '@ai-sdlc/application/ports';
import type { AgentPort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
import { runExternalCli } from './external-cli-runner.js';

export interface CodexAdapterOptions {
  binaryPath?: string;
  artifactsDir: string;
  timeoutMsDefault?: number;
}

/**
 * Runtime backed by the Codex CLI (`codex`).
 *
 * Verified headless contract (codex-cli 0.130.0):
 *   codex exec --sandbox workspace-write --color never --json "-"
 *   (the prompt is piped to stdin; "-" tells codex exec to read stdin)
 *
 * Structural error classification (quota, provider errors) is performed by
 * parsing the --json event stream, eliminating false-positives from agent
 * transcript text.
 */
export class CodexAgentAdapter implements AgentPort {
  constructor(private readonly opts: CodexAdapterOptions) {}

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    const bin = this.opts.binaryPath ?? 'codex';
    const prompt = readFileSync(request.promptPath, 'utf-8');
    const args = ['exec', '--sandbox', 'workspace-write', '--color', 'never', '--json', '-'];
    if (request.model && request.model !== 'default') {
      args.push('--model', request.model);
    }
    const result = await runExternalCli({
      input: prompt,
      runtime: 'codex',
      bin,
      args,
      cwd: request.cwd,
      artifactsDir: this.opts.artifactsDir,
      model: request.model ?? '',
      ...(request.provider !== undefined ? { provider: request.provider } : {}),
      ...(this.opts.timeoutMsDefault !== undefined
        ? { timeoutMsDefault: this.opts.timeoutMsDefault }
        : {}),
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      startCommitSha: request.startCommitSha,
      expectedArtifacts: request.expectedArtifacts,
      skipErrorScanning: true,
    });

    try {
      const stdoutLog = readFileSync(result.stdoutPath, 'utf-8');
      const lines = stdoutLog.split('\n');

      let cleanTranscript = '';
      let detectedError: string | null = null;
      let usage: AgentInvocationResult['usage'] | undefined;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'item.completed' && ev.item) {
            if (ev.item.type === 'agent_message' || ev.item.type === 'reasoning') {
              cleanTranscript += ev.item.text ?? '';
            } else if (ev.item.type === 'error') {
              detectedError = ev.item.message ?? 'Unknown item error';
            }
          } else if (ev.type === 'error') {
            detectedError = ev.message ?? 'Unknown top-level error';
          } else if (ev.type === 'turn.failed') {
            detectedError = ev.error?.message ?? 'Unknown turn failure';
          } else if (ev.type === 'turn.completed' && ev.usage) {
            usage = {
              inputTokens: ev.usage.input_tokens ?? ev.usage.prompt_tokens ?? 0,
              outputTokens: ev.usage.output_tokens ?? ev.usage.completion_tokens ?? 0,
              ...(ev.usage.reasoning_tokens !== undefined
                ? { reasoningTokens: ev.usage.reasoning_tokens }
                : {}),
              ...(ev.usage.cache_read_tokens !== undefined
                ? { cachedTokens: ev.usage.cache_read_tokens }
                : {}),
            };
          }
        } catch {
          // Non-JSON or malformed - ignore
        }
      }

      // Update the result with extracted usage and clean transcript
      if (usage) result.usage = usage;
      writeFileSync(result.stdoutPath, cleanTranscript);

      if (detectedError) {
        result.outcome = 'failed';
        if (!result.contractViolations.includes(CONTRACT_VIOLATION_CODES.PROVIDER_ERROR)) {
          result.contractViolations.push(CONTRACT_VIOLATION_CODES.PROVIDER_ERROR);
        }

        // Deep-parse the error message if it's JSON
        let errorData: any = {};
        try {
          errorData = JSON.parse(detectedError);
        } catch {
          // Not JSON
        }

        const status = errorData.status || errorData.error?.status;
        const errorType = errorData.error?.type || errorData.type;
        const errorMessage = String(errorData.error?.message || errorData.message || detectedError);

        let marker = 'PROVIDER_ERROR';
        if (status === 429 || errorType === 'insufficient_quota' || errorType === 'quota_exceeded') {
          marker = 'QUOTA_EXCEEDED';
        } else if (
          errorType === 'context_length_exceeded' ||
          errorMessage.toLowerCase().includes('maximum context length')
        ) {
          marker = 'TOKEN_LIMIT_EXCEEDED';
        } else if (status >= 500) {
          marker = 'PROVIDER_ERROR';
        }

        const stderrLog = readFileSync(result.stderrPath, 'utf-8');
        writeFileSync(result.stderrPath, `${marker}: ${errorMessage}\n${stderrLog}`);
      }
    } catch (e) {
      // Best-effort parsing. If it fails, result stands as-is (from runExternalCli).
    }

    return result;
  }
}

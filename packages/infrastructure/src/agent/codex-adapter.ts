import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
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
 * Resolves external Git metadata directories for a worktree so that Codex's
 * Landlock/bubblewrap sandbox (--sandbox workspace-write) permits writing to
 * worktree index locks and git objects located in the shared repository.
 */
export function resolveWorktreeGitDirs(cwd: string): string[] {
  try {
    const gitPath = join(cwd, '.git');
    if (!existsSync(gitPath) || !statSync(gitPath).isFile()) {
      return [];
    }
    const content = readFileSync(gitPath, 'utf-8').trim();
    if (!content.startsWith('gitdir:')) {
      return [];
    }
    const rawGitDir = content.slice('gitdir:'.length).trim();
    const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(cwd, rawGitDir);
    const dirs = new Set<string>();
    if (existsSync(gitDir)) {
      dirs.add(gitDir);
      const commonPath = join(gitDir, 'commondir');
      if (existsSync(commonPath)) {
        const rawCommon = readFileSync(commonPath, 'utf-8').trim();
        const commonDir = isAbsolute(rawCommon) ? rawCommon : resolve(gitDir, rawCommon);
        if (existsSync(commonDir)) {
          dirs.add(commonDir);
        }
      }
    }
    return Array.from(dirs);
  } catch {
    return [];
  }
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
    const worktreeGitDirs = resolveWorktreeGitDirs(request.cwd);
    for (const dir of worktreeGitDirs) {
      args.push('--add-dir', dir);
    }
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
      const rawEventsPath = `${result.stdoutPath}.events.jsonl`;
      const stdoutLog = readFileSync(result.stdoutPath, 'utf-8');
      writeFileSync(rawEventsPath, stdoutLog);
      result.usageSourcePaths = [rawEventsPath];
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
            // Field names verified live against codex-cli 0.149.0 (#943): the
            // real event carries `cached_input_tokens` and
            // `reasoning_output_tokens`, not `cache_read_tokens` /
            // `reasoning_tokens` — the latter silently matched nothing,
            // which is why cached_tokens was NULL on all 237 existing rows.
            // Old names kept as a fallback in case an older codex version
            // used them.
            const reasoningTokens = ev.usage.reasoning_output_tokens ?? ev.usage.reasoning_tokens;
            const cachedTokens = ev.usage.cached_input_tokens ?? ev.usage.cache_read_tokens;
            usage = {
              inputTokens: ev.usage.input_tokens ?? ev.usage.prompt_tokens ?? 0,
              outputTokens: ev.usage.output_tokens ?? ev.usage.completion_tokens ?? 0,
              ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
              ...(cachedTokens !== undefined ? { cachedTokens } : {}),
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
        let errorData: {
          status?: number;
          type?: string;
          message?: string;
          error?: { status?: number; type?: string; message?: string };
        } = {};
        try {
          errorData = JSON.parse(detectedError);
        } catch {
          // Not JSON
        }

        const status: number | undefined = errorData.status ?? errorData.error?.status;
        const errorType = errorData.error?.type || errorData.type;
        const errorMessage = String(errorData.error?.message || errorData.message || detectedError);

        let marker = 'PROVIDER_ERROR';
        if (
          (status !== undefined && status === 429) ||
          errorType === 'insufficient_quota' ||
          errorType === 'quota_exceeded'
        ) {
          marker = 'QUOTA_EXCEEDED';
        } else if (
          errorType === 'context_length_exceeded' ||
          errorMessage.toLowerCase().includes('maximum context length')
        ) {
          marker = 'TOKEN_LIMIT_EXCEEDED';
        } else if (typeof status === 'number' && status >= 500) {
          marker = 'PROVIDER_ERROR';
        }

        const stderrLog = readFileSync(result.stderrPath, 'utf-8');
        writeFileSync(result.stderrPath, `${marker}: ${errorMessage}\n${stderrLog}`);
      }
    } catch {
      // Best-effort parsing. If it fails, result stands as-is (from runExternalCli).
    }

    return result;
  }
}

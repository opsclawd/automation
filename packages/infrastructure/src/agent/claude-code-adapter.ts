import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentPort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
import { runExternalCli } from './external-cli-runner.js';

export interface ClaudeCodeAdapterOptions {
  binaryPath?: string;
  artifactsDir: string;
  timeoutMsDefault?: number;
  // Override the root of Claude Code's own transcript store. Defaults to
  // Claude Code's real location, ~/.claude/projects/ (#943) — verified against
  // live data to carry real, populated per-turn `usage` objects, unlike stdout
  // in --output-format text mode (the adapter's own output format, unchanged;
  // switching it to `json` would make runExternalCli's NO_OUTPUT / provider-error
  // scanning see an always-non-empty, JSON-wrapped stdout instead of the plain
  // text it currently reasons about, which is a shared function used by other
  // callers too — reading the transcript files after the fact is purely
  // additive and carries none of that risk).
  transcriptsRoot?: string;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ClaudeCodeUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
}

// Claude Code's own project directory naming: every '/' and '.' in the cwd is
// replaced with '-'. Verified against real, observed directory names on this
// host — round-trips exactly for paths with dots in intermediate segments
// (e.g. "/home/x/.openclaw/y" -> "-home-x--openclaw-y").
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

// Sum usage across a Claude Code transcript file. Each assistant API response
// is written as ONE OR MORE JSONL lines (one per content block — thinking,
// text, tool-use — all sharing the same message.id and an identical `usage`
// snapshot for that call). Summing every usage-bearing line double- or
// triple-counts the same call; this dedupes by message.id first, matching
// exactly one usage value per real API call, then sums across calls — each
// call is a separately-billed request, so summing across calls (not just
// taking the last) is the correct total for the session. Verified against a
// real transcript: 86 raw usage-bearing lines deduped to 47 unique message
// ids with sane, non-inflated summed totals.
export function parseClaudeTranscriptUsage(content: string): ClaudeCodeUsage | undefined {
  const byMessageId = new Map<string, ClaudeUsage>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as { type?: unknown; message?: unknown };
    if (record.type !== 'assistant') continue;
    const message = record.message;
    if (typeof message !== 'object' || message === null) continue;
    const messageRecord = message as { id?: unknown; usage?: unknown };
    const id = messageRecord.id;
    const usage = messageRecord.usage;
    if (typeof id !== 'string' || typeof usage !== 'object' || usage === null) continue;
    if (!byMessageId.has(id)) {
      byMessageId.set(id, usage as ClaudeUsage);
    }
  }
  if (byMessageId.size === 0) return undefined;

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  for (const usage of byMessageId.values()) {
    inputTokens += usage.input_tokens ?? 0;
    outputTokens += usage.output_tokens ?? 0;
    cachedTokens += (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  }
  if (inputTokens === 0 && outputTokens === 0 && cachedTokens === 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
  };
}

function snapshotTranscriptFiles(projectDir: string): Set<string> {
  try {
    return new Set(readdirSync(projectDir).filter((f) => f.endsWith('.jsonl')));
  } catch {
    return new Set();
  }
}

function newTranscriptFiles(projectDir: string, preexisting: Set<string>): string[] {
  try {
    return readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl') && !preexisting.has(f))
      .map((f) => join(projectDir, f));
  } catch {
    return [];
  }
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

    const transcriptsRoot = this.opts.transcriptsRoot ?? join(homedir(), '.claude', 'projects');
    const projectDir = join(transcriptsRoot, claudeProjectDirName(request.cwd));
    const preexisting = snapshotTranscriptFiles(projectDir);

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

    const transcriptPaths = newTranscriptFiles(projectDir, preexisting);
    if (transcriptPaths.length === 0) return result;

    let usage: ClaudeCodeUsage | undefined;
    for (const transcriptPath of transcriptPaths) {
      let content: string;
      try {
        content = existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf-8') : '';
      } catch {
        continue;
      }
      const fileUsage = parseClaudeTranscriptUsage(content);
      if (!fileUsage) continue;
      usage = usage
        ? {
            inputTokens: usage.inputTokens + fileUsage.inputTokens,
            outputTokens: usage.outputTokens + fileUsage.outputTokens,
            ...(usage.cachedTokens || fileUsage.cachedTokens
              ? { cachedTokens: (usage.cachedTokens ?? 0) + (fileUsage.cachedTokens ?? 0) }
              : {}),
          }
        : fileUsage;
    }

    return {
      ...result,
      ...(usage ? { usage } : {}),
      usageSourcePaths: transcriptPaths,
    };
  }
}

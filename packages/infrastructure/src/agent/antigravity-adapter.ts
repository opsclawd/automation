import {
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  statSync,
  mkdirSync,
  writeFileSync,
  promises as fsPromises,
} from 'node:fs';
import { resolve, join, dirname, basename, relative, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { ConfigError } from '@ai-sdlc/shared';
import { CONTRACT_VIOLATION_CODES } from '@ai-sdlc/application/ports';
import type { AgentPort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
import { runExternalCli } from './external-cli-runner.js';
import { testProviderErrorPatterns, testQuotaPatterns } from './error-patterns.js';

export interface AntigravityParsedResult {
  response: string;
  usage: Record<string, unknown>;
  status?: string;
  error?: string;
}

// Parses the NDJSON stream produced by --output-format stream-json (and legacy
// json envelope). Extracts response and usage from the final {"event":"result","result":{...}}
// line, ignoring intermediate step_update / tool-call events.
// Returns undefined for anything that isn't that shape — including plain-text
// stdout from fixtures/mocks that don't model the JSON contract, and any future
// agy version that changes it — so callers degrade to "no usage data" rather than crash.
export function parseAntigravityJsonResponse(raw: string): AntigravityParsedResult | undefined {
  if (!raw.trim()) return undefined;

  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null) {
        // Stream-json result event: {"event":"result","result":{"response":"...","usage":{...}}}
        if (
          'event' in parsed &&
          parsed.event === 'result' &&
          'result' in parsed &&
          typeof parsed.result === 'object' &&
          parsed.result !== null
        ) {
          const res = parsed.result as {
            response?: unknown;
            usage?: unknown;
            status?: unknown;
            error?: unknown;
          };
          if (
            typeof res.response === 'string' ||
            typeof res.error === 'string' ||
            typeof res.status === 'string'
          ) {
            const usage =
              typeof res.usage === 'object' && res.usage !== null
                ? (res.usage as Record<string, unknown>)
                : {};
            const response = typeof res.response === 'string' ? res.response : '';
            const status = typeof res.status === 'string' ? res.status : undefined;
            const error = typeof res.error === 'string' ? res.error : undefined;
            return {
              response,
              usage,
              ...(status !== undefined ? { status } : {}),
              ...(error !== undefined ? { error } : {}),
            };
          }
        }
        // Legacy single-line JSON format: {"response":"...","usage":{...}}
        if ('response' in parsed && typeof parsed.response === 'string') {
          const usage =
            typeof parsed.usage === 'object' && parsed.usage !== null
              ? (parsed.usage as Record<string, unknown>)
              : {};
          const status =
            typeof (parsed as Record<string, unknown>).status === 'string'
              ? ((parsed as Record<string, unknown>).status as string)
              : undefined;
          const error =
            typeof (parsed as Record<string, unknown>).error === 'string'
              ? ((parsed as Record<string, unknown>).error as string)
              : undefined;
          return {
            response: parsed.response,
            usage,
            ...(status !== undefined ? { status } : {}),
            ...(error !== undefined ? { error } : {}),
          };
        }
      }
    } catch {
      // Ignore unparseable lines (e.g. intermediate logs)
    }
  }

  // Fallback for pretty-printed single JSON object across multiple lines
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      if (
        'event' in parsed &&
        parsed.event === 'result' &&
        'result' in parsed &&
        typeof parsed.result === 'object' &&
        parsed.result !== null
      ) {
        const res = parsed.result as {
          response?: unknown;
          usage?: unknown;
          status?: unknown;
          error?: unknown;
        };
        if (
          typeof res.response === 'string' ||
          typeof res.error === 'string' ||
          typeof res.status === 'string'
        ) {
          const usage =
            typeof res.usage === 'object' && res.usage !== null
              ? (res.usage as Record<string, unknown>)
              : {};
          const response = typeof res.response === 'string' ? res.response : '';
          const status = typeof res.status === 'string' ? res.status : undefined;
          const error = typeof res.error === 'string' ? res.error : undefined;
          return {
            response,
            usage,
            ...(status !== undefined ? { status } : {}),
            ...(error !== undefined ? { error } : {}),
          };
        }
      }
      if ('response' in parsed && typeof parsed.response === 'string') {
        const usage =
          typeof parsed.usage === 'object' && parsed.usage !== null
            ? (parsed.usage as Record<string, unknown>)
            : {};
        const status =
          typeof (parsed as Record<string, unknown>).status === 'string'
            ? ((parsed as Record<string, unknown>).status as string)
            : undefined;
        const error =
          typeof (parsed as Record<string, unknown>).error === 'string'
            ? ((parsed as Record<string, unknown>).error as string)
            : undefined;
        return {
          response: parsed.response,
          usage,
          ...(status !== undefined ? { status } : {}),
          ...(error !== undefined ? { error } : {}),
        };
      }
    }
  } catch {
    // Plain text or unparseable JSON
  }

  return undefined;
}

// Mutates `result` in place:
// 1. Inspects CLI process stderr for genuine provider/quota errors (which never
//    contain echoed agent tool outputs).
// 2. Parses the --output-format stream-json envelope from stdout, extracting usage,
//    structured ERROR signals, and the plain model response.
// 3. Rewrites stdoutPath to the plain response text.
// 4. Corrects NO_OUTPUT when response is empty with no git changes.
// 5. Degrades to legacy plain-text scanning when stdout is not JSON.
function applyAntigravityJsonUsage(
  result: AgentInvocationResult,
  request: AgentInvocationRequest,
): void {
  // 1. Check CLI process stderr for genuine provider/quota errors.
  // agy never writes agent tool execution output to its own stderr (tool output
  // is encapsulated inside stream-json step_update events on stdout), so stderr
  // is clean of echoed HTTP status codes and test names.
  let stderrContent = '';
  try {
    stderrContent = existsSync(result.stderrPath) ? readFileSync(result.stderrPath, 'utf-8') : '';
  } catch {
    // best-effort read
  }

  const stderrProviderMatch = testProviderErrorPatterns(stderrContent, { maxLines: 2000 });
  if (stderrProviderMatch) {
    result.outcome = 'failed';
    if (!result.contractViolations.includes(CONTRACT_VIOLATION_CODES.PROVIDER_ERROR)) {
      result.contractViolations.push(CONTRACT_VIOLATION_CODES.PROVIDER_ERROR);
    }
    const quotaLine = testQuotaPatterns(stderrContent, { maxLines: 2000 });
    const marker = quotaLine
      ? `QUOTA_EXCEEDED: ${quotaLine}`
      : `PROVIDER_ERROR: ${stderrProviderMatch}`;
    if (
      !stderrContent.startsWith('QUOTA_EXCEEDED:') &&
      !stderrContent.startsWith('PROVIDER_ERROR:')
    ) {
      stderrContent = `${marker}\n${stderrContent}`;
      try {
        writeFileSync(result.stderrPath, stderrContent);
      } catch {
        // best-effort write
      }
    }
  }

  // 2. Read and parse stdout
  let rawStdout: string;
  try {
    rawStdout = existsSync(result.stdoutPath) ? readFileSync(result.stdoutPath, 'utf-8') : '';
  } catch {
    return;
  }
  const parsed = parseAntigravityJsonResponse(rawStdout);
  if (!parsed) {
    // Fallback for legacy plain-text output (e.g. mock fixtures that don't emit JSON).
    // In legacy plain-text mode, a 0-exit child may have written a provider failure
    // directly to stdout (fake-agy-provider-error-stdout-only.sh).
    if (result.outcome === 'success') {
      const stdoutProviderMatch = testProviderErrorPatterns(rawStdout, { maxLines: 2000 });
      if (stdoutProviderMatch) {
        result.outcome = 'failed';
        if (!result.contractViolations.includes(CONTRACT_VIOLATION_CODES.PROVIDER_ERROR)) {
          result.contractViolations.push(CONTRACT_VIOLATION_CODES.PROVIDER_ERROR);
        }
        const quotaLine = testQuotaPatterns(rawStdout, { maxLines: 2000 });
        const marker = quotaLine
          ? `QUOTA_EXCEEDED: ${quotaLine}`
          : `PROVIDER_ERROR: ${stdoutProviderMatch}`;
        if (
          !stderrContent.startsWith('QUOTA_EXCEEDED:') &&
          !stderrContent.startsWith('PROVIDER_ERROR:')
        ) {
          stderrContent = `${marker}\n${stderrContent}`;
          try {
            writeFileSync(result.stderrPath, stderrContent);
          } catch {
            // best-effort write
          }
        }
      }
    }
    return;
  }

  const { response, usage: u, status, error: resultError } = parsed;

  // Every other runtime's stdoutPath holds the plain model response, and it's
  // read generically downstream (repair-loop transcript evidence, failure
  // diagnostics — see readTail() callers in compose.ts) with no runtime-
  // specific handling. Rewriting back to plain text here keeps that content
  // human-readable instead of a JSON-escaped single line, without needing to
  // special-case antigravity at every one of those call sites.
  try {
    writeFileSync(result.stdoutPath, response);
  } catch {
    // best-effort write
  }
  const inputTokens = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
  const outputTokens = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
  const reasoningTokens = typeof u.thinking_tokens === 'number' ? u.thinking_tokens : 0;
  const cachedTokens = typeof u.cache_read_tokens === 'number' ? u.cache_read_tokens : 0;
  if (inputTokens > 0 || outputTokens > 0) {
    result.usage = {
      inputTokens,
      outputTokens,
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
      ...(cachedTokens > 0 ? { cachedTokens } : {}),
    };
    result.usageSourcePaths = [result.stdoutPath];
  }

  // Structured error signals from stream-json:
  // When status === 'ERROR' or error is present, classify genuine provider/quota failures.
  // Crucially, when status === 'SUCCESS', intermediate step_update tool outputs (e.g.
  // manage_task echoing vitest logs that mention HTTP 429/500) and model response text
  // are NOT regex-scanned, eliminating false-positive provider errors (#1172).
  if (status === 'ERROR' || (resultError && resultError.trim().length > 0)) {
    result.outcome = 'failed';
    const errText = (resultError ?? response).trim();
    const quotaMatch = testQuotaPatterns(errText, { maxLines: 2000 });
    const providerMatch = testProviderErrorPatterns(errText, { maxLines: 2000 });
    if (providerMatch || quotaMatch) {
      if (!result.contractViolations.includes(CONTRACT_VIOLATION_CODES.PROVIDER_ERROR)) {
        result.contractViolations.push(CONTRACT_VIOLATION_CODES.PROVIDER_ERROR);
      }
      const marker = quotaMatch
        ? `QUOTA_EXCEEDED: ${quotaMatch}`
        : `PROVIDER_ERROR: ${providerMatch}`;
      if (
        !stderrContent.startsWith('QUOTA_EXCEEDED:') &&
        !stderrContent.startsWith('PROVIDER_ERROR:')
      ) {
        stderrContent = `${marker}\n${stderrContent}`;
        try {
          writeFileSync(result.stderrPath, stderrContent);
        } catch {
          // best-effort write
        }
      }
    } else if (errText && !stderrContent.includes(errText)) {
      stderrContent = `ERROR: ${errText}\n${stderrContent}`;
      try {
        writeFileSync(result.stderrPath, stderrContent);
      } catch {
        // best-effort write
      }
    }
  } else if (
    result.outcome === 'success' &&
    result.contractViolations.length === 0 &&
    request.startCommitSha &&
    result.endCommitSha === request.startCommitSha &&
    !response.trim() &&
    !(request.expectedArtifacts ?? []).length
  ) {
    if (!stderrContent.trim()) {
      result.outcome = 'contract_violation';
      result.contractViolations = [CONTRACT_VIOLATION_CODES.NO_OUTPUT];
      const note = `NO_OUTPUT: agent exited 0 with empty response and no git changes\n${stderrContent}`;
      try {
        writeFileSync(result.stderrPath, note);
      } catch {
        // best-effort write
      }
    }
  }
}

const AGY_MODEL_LABEL_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)',
});

const AGY_MODEL_SLUG_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9]+)*(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)+$/;

function titleCaseSlugPart(part: string): string {
  return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
}

function resolveAgyModelLabel(slug: string | undefined): string | null {
  if (slug === undefined || slug === '' || slug === 'default') return null;

  const exception = Object.hasOwn(AGY_MODEL_LABEL_EXCEPTIONS, slug)
    ? AGY_MODEL_LABEL_EXCEPTIONS[slug]
    : undefined;
  if (exception !== undefined) return exception;

  if (!AGY_MODEL_SLUG_PATTERN.test(slug)) {
    throw new ConfigError(
      `antigravity profile configured with invalid model slug '${slug}'. ` +
        `Expected a lowercase hyphen-delimited slug such as 'gemini-3.8-flash-high'.`,
    );
  }

  const parts = slug.split('-');
  const qualifier = parts.pop()!;
  const base = parts.map(titleCaseSlugPart).join(' ');
  return `${base} (${titleCaseSlugPart(qualifier)})`;
}

export interface AntigravityAdapterOptions {
  binaryPath?: string;
  artifactsDir: string;
  timeoutMsDefault?: number;
  env?: Record<string, string>;
  scratchDir?: string;
  brainDir?: string;
}

export function validateScratchDir(dir: string): void {
  const resolved = resolve(dir);
  const home = resolve(homedir());
  const cwd = resolve(process.cwd());
  const temp = resolve(tmpdir());
  const geminiRoot = resolve(join(home, '.gemini'));

  if (
    resolved === '/' ||
    resolved === home ||
    resolved === cwd ||
    resolved === geminiRoot ||
    resolved === temp ||
    home.startsWith(resolved) ||
    cwd.startsWith(resolved)
  ) {
    throw new Error(`Unsafe scratch directory path: ${dir}`);
  }

  const relativeGemini = relative(geminiRoot, resolved);
  const inGemini =
    relativeGemini !== '' && !relativeGemini.startsWith('..') && !isAbsolute(relativeGemini);
  const relativeTemp = relative(temp, resolved);
  const inTemp = relativeTemp !== '' && !relativeTemp.startsWith('..') && !isAbsolute(relativeTemp);

  if (!inGemini && !inTemp) {
    throw new Error(`Scratch directory must be inside .gemini or temp directory: ${dir}`);
  }
}

function clearDirectory(dir: string): void {
  validateScratchDir(dir);
  if (!existsSync(dir)) return;
  try {
    for (const entry of readdirSync(dir)) {
      try {
        rmSync(resolve(dir, entry), { recursive: true, force: true });
      } catch {
        // Best effort clean: ignore individual file deletion failures
      }
    }
  } catch {
    // Best effort: ignore readdir failures
  }
}

function findExpectedArtifactsInDir(scratchDir: string, expectedArtifacts: string[]): string[] {
  if (!existsSync(scratchDir)) return [];
  const found: string[] = [];
  try {
    for (const entry of readdirSync(scratchDir, { recursive: true, encoding: 'utf-8' })) {
      const fullPath = join(scratchDir, entry);
      try {
        if (statSync(fullPath).isFile()) {
          // Only match if the exact relative path in the scratch directory
          // matches one of the expected relative paths.
          if (expectedArtifacts.includes(entry)) {
            found.push(entry);
          }
        }
      } catch {
        // Ignore errors from broken symlinks, restricted permissions, etc.
      }
    }
  } catch {
    // Ignore readdir failures
  }
  return found;
}

/**
 * Searches one level deep in brainRoot for a file whose basename matches
 * artifactBasename. Prioritizes the directory matching runId, then falls back
 * to scanning other UUID subdirectories asynchronously, sorted by mtime descending.
 */
async function findArtifactInBrainDir(
  brainRoot: string,
  artifactBasename: string,
  runId?: string,
): Promise<string | null> {
  try {
    const rootStat = await fsPromises.stat(brainRoot);
    if (!rootStat.isDirectory()) return null;
  } catch {
    return null;
  }

  // 1. Check subdirectory matching runId first
  if (runId) {
    const candidate = join(brainRoot, runId, artifactBasename);
    const resolvedCandidate = resolve(candidate);
    const resolvedBrainRoot = resolve(brainRoot);
    if (resolvedCandidate.startsWith(resolvedBrainRoot + '/')) {
      try {
        const st = await fsPromises.stat(resolvedCandidate);
        if (st.isFile()) {
          return resolvedCandidate;
        }
      } catch {
        // Ignore
      }
    }
  }

  // 2. Fallback scan of the whole directory (performed asynchronously)
  const matches: { path: string; mtimeMs: number }[] = [];
  try {
    const uuidEntries = await fsPromises.readdir(brainRoot);
    const directoryDetails: { entry: string; mtimeMs: number }[] = [];

    // Limit concurrency by batching directory stat calls (chunk size of 50)
    const batchSize = 50;
    for (let i = 0; i < uuidEntries.length; i += batchSize) {
      const chunk = uuidEntries.slice(i, i + batchSize);
      await Promise.all(
        chunk.map(async (entry) => {
          const fullPath = join(brainRoot, entry);
          try {
            const st = await fsPromises.stat(fullPath);
            if (st.isDirectory()) {
              directoryDetails.push({ entry, mtimeMs: st.mtimeMs });
            }
          } catch {
            // Skip inaccessible or failed entries
          }
        }),
      );
    }

    // Sort directories by modification time descending
    directoryDetails.sort((a, b) => b.mtimeMs - a.mtimeMs);

    // Limit to the 1000 most recent directories
    const entriesToCheck = directoryDetails.slice(0, 1000);

    // Limit concurrency by batching candidate file checks (chunk size of 50)
    for (let i = 0; i < entriesToCheck.length; i += batchSize) {
      const chunk = entriesToCheck.slice(i, i + batchSize);
      await Promise.all(
        chunk.map(async (dirDetail) => {
          const candidate = join(brainRoot, dirDetail.entry, artifactBasename);
          try {
            const fileStat = await fsPromises.stat(candidate);
            if (fileStat.isFile()) {
              matches.push({ path: candidate, mtimeMs: fileStat.mtimeMs });
            }
          } catch {
            // Ignore
          }
        }),
      );
    }
  } catch {
    return null;
  }

  if (matches.length === 0) return null;

  // Implement uniqueness guard: if multiple directories contain the same artifact basename, recovery fails.
  if (matches.length > 1) {
    return null;
  }

  return matches[0]!.path;
}

export class AntigravityAgentAdapter implements AgentPort {
  constructor(private readonly opts: AntigravityAdapterOptions) {}

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    const bin = this.opts.binaryPath ?? 'agy';
    const prompt = readFileSync(request.promptPath, 'utf-8');

    const scratchDir =
      this.opts.scratchDir ?? resolve(homedir(), '.gemini/antigravity-cli/scratch');

    // Pre: clear stale scratch state so agy does not load files
    // from a prior unrelated session.
    clearDirectory(scratchDir);

    // --add-dir registers the worktree as an agy workspace. Without it, agy
    // resolves relative artifact paths (e.g. ./spec-review-task-2.md) against
    // its own default workspace/scratch dir instead of request.cwd, so review
    // findings get written outside the worktree and the orchestrator never
    // sees them (observed on issue #146: the .md landed in ~/projects and
    // ~/.gemini/.../scratch instead of the worktree).

    // agy's --print mode has a 5-minute internal response timeout by default.
    // High-quality models on complex prompts regularly exceed this, causing a
    // contract_violation (missing artifact) that forces an unnecessary fallback.
    // Derive --print-timeout from the effective per-invocation timeout
    // (forwarded by the router as request.timeoutMs) so it always matches the
    // actual orchestrator budget regardless of profile or caller overrides.
    const printTimeoutMs = request.timeoutMs ?? this.opts.timeoutMsDefault ?? 30 * 60 * 1000;
    const printTimeoutMins = Math.max(1, Math.floor(printTimeoutMs / 60_000) - 1);
    const modelLabel = resolveAgyModelLabel(request.model);

    // Headless stream-json contract (verified against agy >= 1.1.28, #1157):
    // passing the prompt via stdin with --input-format stream-json and
    // --output-format stream-json allows arbitrary-size prompts without hitting
    // Linux's single argv element kernel limit (MAX_ARG_STRLEN = 131,072 bytes).
    // Positional --print requires a value, passed as '' (empty string), while
    // the turn arrives as an NDJSON user event message on stdin.
    //
    // Note: plain positional '-' raw text stdin remains broken in agy (#709,
    // causes generic greeting failure); --input-format stream-json is a
    // distinct, verified structured protocol that avoids that bug.
    //
    // --dangerously-skip-permissions and detached:true are load-bearing, not
    // incidental — verified directly against the live binary: without
    // --dangerously-skip-permissions, any tool-using prompt (reading a file,
    // running a command — i.e. virtually every real task) blocks waiting for
    // interactive permission approval that can never arrive in this headless
    // context, and the process hangs until the external timeout kills it
    // (confirmed: `agy --print "<tool-using prompt>" </dev/null` times out;
    // the identical invocation with --dangerously-skip-permissions completes
    // normally).
    //
    // --output-format stream-json produces NDJSON events ending in
    // {"event":"result","result":{"response","usage",...}}; `usage` carries
    // real input/output/thinking/cache_read token counts.
    const args = [
      '--dangerously-skip-permissions',
      '--add-dir',
      request.cwd,
      '--print-timeout',
      `${printTimeoutMins}m`,
      ...(modelLabel !== null ? ['--model', modelLabel] : []),
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--print',
      '',
    ];
    const result = await runExternalCli({
      runtime: 'antigravity',
      bin,
      args,
      input:
        JSON.stringify({
          event: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: prompt }],
          },
        }) + '\n',
      detached: true,
      cwd: request.cwd,
      artifactsDir: this.opts.artifactsDir,
      model: request.model ?? '',
      ...(this.opts.env !== undefined ? { env: this.opts.env } : {}),
      ...(request.provider !== undefined ? { provider: request.provider } : {}),
      ...(this.opts.timeoutMsDefault !== undefined
        ? { timeoutMsDefault: this.opts.timeoutMsDefault }
        : {}),
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      startCommitSha: request.startCommitSha,
      expectedArtifacts: request.expectedArtifacts,
      ...(request.resultJsonPath ? { resultJsonPath: request.resultJsonPath } : {}),
      skipErrorScanning: true,
    });

    applyAntigravityJsonUsage(result, request);

    // Post: detect and recover artifacts wrongly written to scratch
    if (
      result.outcome === 'contract_violation' &&
      result.contractViolations.includes(CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT)
    ) {
      try {
        const stray = findExpectedArtifactsInDir(scratchDir, request.expectedArtifacts ?? []);
        if (stray.length > 0) {
          if (
            !result.contractViolations.includes(CONTRACT_VIOLATION_CODES.ARTIFACT_IN_SCRATCH_DIR)
          ) {
            result.contractViolations.push(CONTRACT_VIOLATION_CODES.ARTIFACT_IN_SCRATCH_DIR);
          }

          const recovered: string[] = [];
          const resolvedCwd = resolve(request.cwd);
          for (const relPath of stray) {
            const dest = resolve(join(resolvedCwd, relPath));
            const rel = relative(resolvedCwd, dest);
            if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
              console.warn(`Unsafe recovery destination: ${dest}`);
              continue;
            }
            const src = join(scratchDir, relPath);
            try {
              mkdirSync(dirname(dest), { recursive: true });
              try {
                renameSync(src, dest);
              } catch (err) {
                const error = err as { code?: string };
                if (error.code === 'EXDEV') {
                  copyFileSync(src, dest);
                  unlinkSync(src);
                } else {
                  throw err;
                }
              }
              recovered.push(relPath);
            } catch (err) {
              console.warn(`Failed to recover artifact '${relPath}' from scratch dir:`, err);
            }
          }

          if (recovered.length > 0) {
            const remediationRecords = recovered.map((relPath) => ({
              src: join(scratchDir, relPath),
              artifact: relPath,
            }));

            result.remediatedArtifacts = [
              ...(result.remediatedArtifacts ?? []),
              ...remediationRecords,
            ];

            // Validate if all expected artifacts now exist in the workspace cwd
            const allRecovered = (request.expectedArtifacts ?? []).every((art) =>
              existsSync(join(resolvedCwd, art)),
            );

            if (allRecovered) {
              result.outcome = 'success';
              result.contractViolations = result.contractViolations.filter(
                (cv) => cv !== CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT,
              );
            }
          }
        }
      } catch (err) {
        console.warn('Failed to perform scratch recovery:', err);
      }
    }

    // Post: detect and recover artifacts wrongly written to brain dir
    if (
      result.outcome === 'contract_violation' &&
      result.contractViolations.includes(CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT)
    ) {
      try {
        const brainRoot = this.opts.brainDir ?? resolve(homedir(), '.gemini/antigravity-cli/brain');
        let brainRecoveredAny = false;
        const resolvedCwd = resolve(request.cwd);

        for (const artifact of request.expectedArtifacts ?? []) {
          if (existsSync(join(resolvedCwd, artifact))) continue; // already present
          const match = await findArtifactInBrainDir(brainRoot, basename(artifact), request.runId);
          if (match === null) continue;

          const dest = resolve(join(resolvedCwd, artifact));
          const rel = relative(resolvedCwd, dest);
          if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
            console.warn(`Unsafe recovery destination: ${dest}`);
            continue;
          }
          try {
            mkdirSync(dirname(dest), { recursive: true });
            copyFileSync(match, dest);
            if (
              !result.contractViolations.includes(CONTRACT_VIOLATION_CODES.ARTIFACT_IN_BRAIN_DIR)
            ) {
              result.contractViolations.push(CONTRACT_VIOLATION_CODES.ARTIFACT_IN_BRAIN_DIR);
            }
            result.remediatedArtifacts = [
              ...(result.remediatedArtifacts ?? []),
              { src: match, artifact },
            ];
            brainRecoveredAny = true;
          } catch (err) {
            console.warn(`Failed to recover artifact '${artifact}' from brain dir:`, err);
          }
        }

        if (brainRecoveredAny) {
          const allRecovered = (request.expectedArtifacts ?? []).every((art) =>
            existsSync(join(resolvedCwd, art)),
          );
          if (allRecovered) {
            result.outcome = 'success';
            result.contractViolations = result.contractViolations.filter(
              (cv) => cv !== CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT,
            );
          }
        }
      } catch (err) {
        console.warn('Failed to perform brain recovery:', err);
      }
    }

    return result;
  }
}

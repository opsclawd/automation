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

interface AntigravityJsonResponse {
  response?: unknown;
  usage?: unknown;
}

// Parses the {"response","usage",...} envelope produced by --output-format
// json (verified live against agy 1.0.3). Returns undefined for anything that
// isn't that exact shape — including plain-text stdout from fixtures/mocks
// that don't model the JSON contract, and any future agy version that changes
// it — so callers degrade to "no usage data" rather than crash.
function parseAntigravityJsonResponse(
  raw: string,
): { response: string; usage: Record<string, unknown> } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { response, usage } = parsed as AntigravityJsonResponse;
  if (typeof response !== 'string' || typeof usage !== 'object' || usage === null) return undefined;
  return { response, usage: usage as Record<string, unknown> };
}

// Mutates `result` in place: attaches usage parsed from the --output-format
// json envelope, and corrects a false negative that switching to json mode
// introduces in runExternalCli's own NO_OUTPUT check. That check tests raw
// stdout for emptiness, but raw stdout is now the JSON envelope, which is
// never empty even when the model's actual response text is — so a
// genuinely empty response would otherwise silently pass as a success.
function applyAntigravityJsonUsage(
  result: AgentInvocationResult,
  request: AgentInvocationRequest,
): void {
  let rawStdout: string;
  try {
    rawStdout = existsSync(result.stdoutPath) ? readFileSync(result.stdoutPath, 'utf-8') : '';
  } catch {
    return;
  }
  const parsed = parseAntigravityJsonResponse(rawStdout);
  if (!parsed) return;

  const { response, usage: u } = parsed;
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

  if (
    result.outcome === 'success' &&
    result.contractViolations.length === 0 &&
    request.startCommitSha &&
    result.endCommitSha === request.startCommitSha &&
    !response.trim() &&
    !(request.expectedArtifacts ?? []).length
  ) {
    let stderrContent = '';
    try {
      stderrContent = existsSync(result.stderrPath) ? readFileSync(result.stderrPath, 'utf-8') : '';
    } catch {
      // best-effort read
    }
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

    // Verified headless contract (agy 1.0.3): passing the prompt as a
    // positional argument after --print is the only verified stable contract.
    // Deviation to '-' + stdin (added in a prior iteration) caused the CLI
    // to ignore the prompt and return a generic greeting in some environments
    // (#709).
    //
    // NOTE: This introduces a risk of E2BIG (argument list too long) for
    // extremely large prompts, but is necessary for correct prompt reception
    // given agy's verified interface.
    //
    // --dangerously-skip-permissions and detached:true are load-bearing, not
    // incidental — verified directly against the live binary: without
    // --dangerously-skip-permissions, any tool-using prompt (reading a file,
    // running a command — i.e. virtually every real task) blocks waiting for
    // interactive permission approval that can never arrive in this headless
    // context, and the process hangs until the external timeout kills it
    // (confirmed: `agy --print "<tool-using prompt>" </dev/null` times out;
    // the identical invocation with --dangerously-skip-permissions completes
    // normally). Removing it trades a fast, wrong response (#709's symptom)
    // for a slow hang on nearly every invocation — strictly worse.
    // --output-format json (verified live against agy 1.0.3, #943) wraps the
    // plain response in {"response","usage",...}; `usage` carries real
    // input/output/thinking/cache_read token counts, unlike default text mode
    // which has no usage signal at all. This is read back below.
    const args = [
      '--dangerously-skip-permissions',
      '--add-dir',
      request.cwd,
      '--print-timeout',
      `${printTimeoutMins}m`,
      ...(modelLabel !== null ? ['--model', modelLabel] : []),
      '--output-format',
      'json',
      '--print',
      prompt,
    ];
    const result = await runExternalCli({
      runtime: 'antigravity',
      bin,
      args,
      input: '', // prompt is passed as a positional arg above; stdin unused
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

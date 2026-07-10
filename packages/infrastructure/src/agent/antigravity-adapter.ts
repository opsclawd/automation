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
  promises as fsPromises,
} from 'node:fs';
import { resolve, join, dirname, basename, relative, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { ConfigError } from '@ai-sdlc/shared';
import { CONTRACT_VIOLATION_CODES } from '@ai-sdlc/application/ports';
import type { AgentPort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
import { runExternalCli } from './external-cli-runner.js';

const AGY_MODEL_SLUG_TO_LABEL: Readonly<Record<string, string>> = Object.freeze({
  'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
  'gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)',
  'gemini-3.5-flash-low': 'Gemini 3.5 Flash (Low)',
  'gemini-3.5-flash-medium': 'Gemini 3.5 Flash (Medium)',
  'gemini-3.5-flash-high': 'Gemini 3.5 Flash (High)',
  'claude-sonnet-4.6-thinking': 'Claude Sonnet 4.6 (Thinking)',
  'claude-opus-4.6-thinking': 'Claude Opus 4.6 (Thinking)',
  'gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)',
});

function resolveAgyModelLabel(slug: string | undefined): string | null {
  if (slug === undefined || slug === '' || slug === 'default') return null;
  const label = AGY_MODEL_SLUG_TO_LABEL[slug];
  if (label === undefined) {
    throw new ConfigError(
      `antigravity profile configured with unknown model '${slug}'. ` +
        `Known slugs: ${Object.keys(AGY_MODEL_SLUG_TO_LABEL).join(', ')}. ` +
        `Update the slug-to-label table or pick a known slug.`,
    );
  }
  return label;
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
    const args = [
      '--dangerously-skip-permissions',
      '--add-dir',
      request.cwd,
      '--print-timeout',
      `${printTimeoutMins}m`,
      ...(modelLabel !== null ? ['--model', modelLabel] : []),
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

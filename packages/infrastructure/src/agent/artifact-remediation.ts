/**
 * Shared artifact-remediation helpers for CLI runtime adapters.
 *
 * Extracted from `external-cli-runner.ts` so that `opencode-adapter.ts` (and any
 * future caller) can run the same recovery flow: recursive basename search with
 * a git-tracked / noise-dir skip, an EXDEV-safe move with empty-ancestor
 * cleanup, and a stem-prefix pass that picks the newest mtime and deletes the
 * untracked source after a copy.
 *
 * Wall-clock note: the freshness filter (`mtimeMs >= startMs`) and
 * `Date.now()` both use the Node process wall clock. Filesystems with
 * 1-second mtime resolution may classify a file written within ~1ms of
 * invocation start as stale. This matches the existing
 * `external-cli-runner.ts` behavior; see
 * `docs/solutions/orchestrator/stem-prefix-newest-wins-disambiguation-2026-07-03.md`.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve } from 'node:path';

const NOISE_DIRS = new Set([
  'node_modules',
  '.next',
  '.cache',
  '.git',
  'dist',
  'build',
  '.turbo',
  '.nuxt',
  'coverage',
  '__pycache__',
  '.venv',
  'vendor',
  '.pytest_cache',
  '.mypy_cache',
  'target',
  'out',
  '.gradle',
]);

export interface RemediateOptions {
  cwd: string;
  startMs: number;
  expectedArtifacts: string[];
  stderrForLog: string;
  sourceDir?: string;
  copyOnly?: boolean;
}

export interface RemediateResult {
  remediatedArtifacts: { src: string; artifact: string }[];
  missingArtifacts: string[];
}

export function findMisplacedCandidate(
  searchRoot: string,
  artifactBasename: string,
  startMs: number,
  excludePaths?: Set<string>,
): string | null {
  try {
    const candidates: string[] = [];
    function scan(dir: string, depth: number) {
      if (depth > 5) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // Skip this unreadable directory and continue
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (NOISE_DIRS.has(entry.name)) continue;
          scan(fullPath, depth + 1);
        } else if (entry.isFile()) {
          if (depth >= 2 && entry.name === artifactBasename) {
            let mtimeMs = 0;
            try {
              mtimeMs = statSync(fullPath).mtimeMs;
            } catch {
              // treat as stale
            }
            if (mtimeMs < startMs) continue;

            const relativePath = relative(searchRoot, fullPath);
            const normalizedRelativePath = relativePath.replace(/\\/g, '/');
            if (excludePaths?.has(normalizedRelativePath)) {
              continue;
            }
            // skip git-tracked files (only untracked/ignored files are candidates)
            try {
              const gitPath = relativePath.replace(/\\/g, '/');
              execFileSync('git', ['ls-files', '--error-unmatch', '--', gitPath], {
                cwd: searchRoot,
                stdio: 'pipe',
              });
              // exit 0 means tracked → skip
              continue;
            } catch (err) {
              const errorWithStatus = err as { status?: number };
              if (errorWithStatus && errorWithStatus.status === 1) {
                // status 1 means command ran but file is not tracked → valid candidate
              } else {
                // any other error (ENOENT, exit code 128, etc.) → do not treat as untracked
                continue;
              }
            }
            candidates.push(relativePath);
          }
        }
      }
    }

    scan(searchRoot, 1);
    return candidates.length === 1 ? candidates[0]! : null;
  } catch {
    return null;
  }
}

export function moveMisplacedArtifact(
  cwd: string,
  srcRelative: string,
  destRelative: string,
): void {
  const src = join(cwd, srcRelative);
  const dest = join(cwd, destRelative);
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
      copyFileSync(src, dest);
      unlinkSync(src);
    } else {
      throw e;
    }
  }
  // Clean up empty ancestor directories up to (but not including) cwd
  let dir = dirname(src);
  while (resolve(dir) !== resolve(cwd) && dir !== dirname(dir)) {
    try {
      rmdirSync(dir);
      dir = dirname(dir);
    } catch {
      break;
    }
  }
}

export function remediateMissingArtifacts(opts: RemediateOptions): RemediateResult {
  const { cwd, startMs, expectedArtifacts, sourceDir, copyOnly } = opts;
  const searchRoot = sourceDir ?? cwd;
  let stderrForLog = opts.stderrForLog;

  const remediatedArtifacts: { src: string; artifact: string }[] = [];

  const excludePaths = new Set<string>();
  for (const artifact of expectedArtifacts) {
    if (existsSync(join(cwd, artifact))) {
      excludePaths.add(artifact.replace(/\\/g, '/'));
    }
  }

  // Pass 1: recursive basename recovery.
  for (const artifact of expectedArtifacts) {
    if (existsSync(join(cwd, artifact))) continue;
    const artifactBasename = basename(artifact);
    const candidate = findMisplacedCandidate(searchRoot, artifactBasename, startMs, excludePaths);
    if (!candidate) continue;
    try {
      if (copyOnly) {
        const dest = join(cwd, artifact);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(join(searchRoot, candidate), dest);
      } else {
        // moveMisplacedArtifact cleans up searchRoot; it assumes dest is relative to searchRoot.
        // This is only correct when searchRoot === cwd.
        moveMisplacedArtifact(searchRoot, candidate, artifact);
      }
      remediatedArtifacts.push({ src: candidate, artifact });
      excludePaths.add(artifact.replace(/\\/g, '/'));
    } catch (e) {
      console.warn('move/copy misplaced artifact failed:', e);
    }
  }

  // Pass 2: stem-prefix recovery (root-only, mtime-disambiguated pick-newest).
  for (const artifact of expectedArtifacts) {
    if (existsSync(join(cwd, artifact))) continue;
    const artifactBasename = basename(artifact);
    const dotIdx = artifactBasename.lastIndexOf('.');
    const stem = dotIdx > 0 ? artifactBasename.slice(0, dotIdx) : artifactBasename;
    const ext = dotIdx > 0 ? artifactBasename.slice(dotIdx) : '';

    let rootEntries: import('node:fs').Dirent[];
    try {
      rootEntries = readdirSync(searchRoot, { withFileTypes: true }) as import('node:fs').Dirent[];
    } catch {
      continue;
    }

    const stemMatches = rootEntries
      .filter(
        (e) =>
          e.isFile() &&
          e.name !== artifactBasename &&
          e.name.startsWith(stem) &&
          // require a separator (-/_) immediately after the stem so that
          // e.g. `planning.md` is not matched when the stem is `plan`
          (e.name[stem.length] === '-' || e.name[stem.length] === '_') &&
          (ext === '' || e.name.endsWith(ext)),
      )
      .map((e) => e.name);

    if (stemMatches.length === 0) continue;
    // Filter to candidates written during THIS invocation. Stale leftovers from
    // prior runs/attempts must not be silently promoted to "remediated artifact":
    // doing so would clear MISSING_REQUIRED_ARTIFACT and mark the run successful
    // using a file the current agent never produced. Stat failures are treated
    // as stale (mtimeMs = 0) so they cannot masquerade as fresh.
    const freshCandidates = stemMatches.flatMap((name) => {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(join(searchRoot, name)).mtimeMs;
      } catch {
        // Race with concurrent delete: treat as stale so a fresh sibling wins.
      }
      return mtimeMs >= startMs ? [{ name, mtimeMs }] : [];
    });
    if (freshCandidates.length === 0) continue;
    freshCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const srcName = freshCandidates[0]!.name;
    const destPath = join(cwd, artifact);
    try {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(join(searchRoot, srcName), destPath);
      remediatedArtifacts.push({ src: srcName, artifact });
      stderrForLog = `STEM_PREFIX_REMEDIATED: ${srcName} → ${artifact}\n${stderrForLog}`;
      // Delete the source if untracked so wrong-named files don't accumulate
      // across steps and break the "exactly 1 match" guard on future retries.
      // Tracked files are left in place — they're already in git history.
      if (!copyOnly) {
        try {
          execFileSync('git', ['ls-files', '--error-unmatch', '--', srcName], {
            cwd: searchRoot,
            stdio: 'pipe',
          });
        } catch (gitErr) {
          if ((gitErr as { status?: number }).status === 1) {
            try {
              unlinkSync(join(searchRoot, srcName));
            } catch {
              // best-effort
            }
          }
        }
      }
    } catch (e) {
      console.warn('stem-prefix remediation failed:', e);
    }
  }

  // Mutate the caller's stderrForLog in place so STEM_PREFIX_REMEDIATED lines
  // are persisted on the next writeFileSync(stderrPath, stderrForLog).
  opts.stderrForLog = stderrForLog;

  const missingArtifacts = expectedArtifacts.filter((a) => !existsSync(join(cwd, a)));

  return { remediatedArtifacts, missingArtifacts };
}

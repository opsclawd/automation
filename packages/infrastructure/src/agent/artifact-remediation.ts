import {
  readdirSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  statSync,
  existsSync,
  rmdirSync,
} from 'node:fs';
import { join, dirname, basename, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const NOISE_DIRS = new Set([
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

export function findMisplacedCandidate(
  cwd: string,
  artifactBasename: string,
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
        if (entry.isDirectory()) {
          if (NOISE_DIRS.has(entry.name)) continue;
          scan(join(dir, entry.name), depth + 1);
        } else if (entry.isFile()) {
          if (depth >= 2 && entry.name === artifactBasename) {
            const relativePath = relative(cwd, join(dir, entry.name));
            const normalizedRelativePath = relativePath.replace(/\\/g, '/');
            if (excludePaths?.has(normalizedRelativePath)) {
              continue;
            }
            // skip git-tracked files (only untracked/ignored files are candidates)
            try {
              const gitPath = relativePath.replace(/\\/g, '/');
              execFileSync('git', ['ls-files', '--error-unmatch', '--', gitPath], {
                cwd,
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

    scan(cwd, 1);
    return candidates.length === 1 ? candidates[0]! : null;
  } catch {
    return null;
  }
}

export function moveMisplacedArtifact(cwd: string, srcRelative: string, destRelative: string): void {
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

export interface RemediationResult {
  remediatedArtifacts?: { src: string; artifact: string }[];
  logMessages: string[];
}

export function remediateArtifacts(
  cwd: string,
  expectedArtifacts: string[],
  startTime: number,
  options: { dryRun?: boolean } = {},
): RemediationResult {
  const remediatedArtifacts: { src: string; artifact: string }[] = [];
  const logMessages: string[] = [];
  const excludePaths = new Set<string>();

  for (const artifact of expectedArtifacts) {
    if (existsSync(join(cwd, artifact))) {
      excludePaths.add(artifact.replace(/\\/g, '/'));
    }
  }

  // First pass: Recursive basename scan
  for (const artifact of expectedArtifacts) {
    if (existsSync(join(cwd, artifact))) continue;
    const artifactBasename = basename(artifact);
    const candidate = findMisplacedCandidate(cwd, artifactBasename, excludePaths);
    if (!candidate) continue;
    try {
      if (!options.dryRun) {
        moveMisplacedArtifact(cwd, candidate, artifact);
      }
      remediatedArtifacts.push({ src: candidate, artifact });
      excludePaths.add(artifact.replace(/\\/g, '/'));
    } catch (e) {
      console.warn('moveMisplacedArtifact failed:', e);
    }
  }

  // Second pass: stem-prefix remediation
  for (const artifact of expectedArtifacts) {
    if (existsSync(join(cwd, artifact))) continue;
    const artifactBasename = basename(artifact);
    const dotIdx = artifactBasename.lastIndexOf('.');
    const stem = dotIdx > 0 ? artifactBasename.slice(0, dotIdx) : artifactBasename;
    const ext = dotIdx > 0 ? artifactBasename.slice(dotIdx) : '';

    let rootEntries: import('node:fs').Dirent[];
    try {
      rootEntries = readdirSync(cwd, { withFileTypes: true }) as import('node:fs').Dirent[];
    } catch {
      continue;
    }

    const stemMatches = rootEntries
      .filter(
        (e) =>
          e.isFile() &&
          e.name !== artifactBasename &&
          e.name.startsWith(stem) &&
          (e.name[stem.length] === '-' || e.name[stem.length] === '_') &&
          (ext === '' || e.name.endsWith(ext)),
      )
      .map((e) => e.name);

    if (stemMatches.length === 0) continue;

    const freshCandidates = stemMatches.flatMap((name) => {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(join(cwd, name)).mtimeMs;
      } catch {
        // Race with concurrent delete
      }
      return mtimeMs >= startTime ? [{ name, mtimeMs }] : [];
    });

    if (freshCandidates.length === 0) continue;
    freshCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const srcName = freshCandidates[0]!.name;
    const destPath = join(cwd, artifact);

    try {
      if (!options.dryRun) {
        mkdirSync(dirname(destPath), { recursive: true });
        copyFileSync(join(cwd, srcName), destPath);
        logMessages.push(`STEM_PREFIX_REMEDIATED: ${srcName} → ${artifact}`);

        // Delete the source if untracked
        try {
          execFileSync('git', ['ls-files', '--error-unmatch', '--', srcName], {
            cwd: cwd,
            stdio: 'pipe',
          });
        } catch (gitErr) {
          if ((gitErr as { status?: number }).status === 1) {
            try {
              unlinkSync(join(cwd, srcName));
            } catch {
              // best-effort
            }
          }
        }
      }
      remediatedArtifacts.push({ src: srcName, artifact });
    } catch (e) {
      console.warn('stem-prefix remediation failed:', e);
    }
  }

  const res: RemediationResult = {
    logMessages,
  };
  if (remediatedArtifacts.length > 0) {
    res.remediatedArtifacts = remediatedArtifacts;
  }
  return res;
}

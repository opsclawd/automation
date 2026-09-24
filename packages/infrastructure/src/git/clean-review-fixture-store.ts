import { readdir, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import type {
  CleanReviewFixtureStoreInput,
  CleanReviewFixtureStoreResult,
  CleanReviewFixtureStorePort,
} from '@ai-sdlc/application/ports';
import { REVIEW_FIXTURE_STORE_DIRNAME, isReviewFixtureStorePath } from '@ai-sdlc/application/ports';
import { git, toLiteralGitPathspec } from './git-runner.js';

function normalizePosix(p: string): string {
  return p.trim().replace(/\\/g, '/');
}

export function assertValidFixtureStoreTarget(cwd: string, rawTarget: string): string {
  if (!rawTarget || typeof rawTarget !== 'string' || rawTarget.trim() === '') {
    throw new Error('Invalid fixture-store target: target directory path must not be empty');
  }

  const trimmed = rawTarget.trim();
  if (trimmed.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(trimmed)) {
    throw new Error(
      `Invalid fixture-store target '${rawTarget}': path must be repository-relative`,
    );
  }

  const resolvedCwd = resolve(cwd);
  const normalized = normalizePosix(trimmed).replace(/^\.\//, '');
  const resolvedTarget = resolve(resolvedCwd, normalized);
  const rel = relative(resolvedCwd, resolvedTarget);

  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith('../') ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(
      `Invalid fixture-store target '${rawTarget}': path traverses outside working directory '${cwd}'`,
    );
  }

  const posixRel = normalizePosix(rel);
  const segments = posixRel.split('/').filter(Boolean);
  const targetBasename = segments[segments.length - 1];

  if (targetBasename !== REVIEW_FIXTURE_STORE_DIRNAME || !isReviewFixtureStorePath(posixRel)) {
    throw new Error(
      `Invalid fixture-store target '${rawTarget}': target basename must be exactly '${REVIEW_FIXTURE_STORE_DIRNAME}'`,
    );
  }

  return posixRel;
}

export function extractFixtureStoreDir(filePath: string): string | undefined {
  const normalized = normalizePosix(filePath).replace(/^\.\//, '');
  const segments = normalized.split('/').filter(Boolean);
  const idx = segments.indexOf(REVIEW_FIXTURE_STORE_DIRNAME);
  if (idx === -1) return undefined;
  return segments.slice(0, idx + 1).join('/');
}

/**
 * Safely discovers all directories named `.review-fixture-store` in the worktree,
 * skipping directories like `.git`, `node_modules`, and `.ai-tmp`, and avoiding symlinks.
 */
export async function findFixtureStoreDirectories(cwd: string): Promise<string[]> {
  const resolvedCwd = resolve(cwd);
  const results: string[] = [];
  const skipDirNames = new Set(['.git', 'node_modules', '.ai-tmp']);

  async function walk(dir: string, relPrefix: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      if (skipDirNames.has(entry.name)) continue;

      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.name === REVIEW_FIXTURE_STORE_DIRNAME) {
        try {
          const validated = assertValidFixtureStoreTarget(resolvedCwd, relPath);
          results.push(validated);
        } catch {
          // Ignore invalid target
        }
        // Do not recurse into .review-fixture-store
        continue;
      }

      await walk(resolve(dir, entry.name), relPath);
    }
  }

  await walk(resolvedCwd, '');
  return Array.from(new Set(results)).sort();
}

interface StatusEntry {
  statusCode: string;
  path: string;
  origPath?: string | undefined;
}

function parseStatusEntries(output: string): StatusEntry[] {
  if (!output) return [];
  const parts = output.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part.length < 3) continue;
    const statusCode = part.slice(0, 2);
    const path = part.slice(3);
    if (statusCode.includes('R') || statusCode.includes('C')) {
      i++;
      const origPath = parts[i];
      entries.push({
        statusCode,
        path,
        ...(origPath !== undefined ? { origPath } : {}),
      });
    } else {
      entries.push({ statusCode, path });
    }
  }
  return entries;
}

async function collectFixtureStatusEntries(cwd: string): Promise<StatusEntry[]> {
  // 1. General status (catches modified, deleted, untracked, renames across the worktree)
  const generalOutput = await git(cwd, ['status', '--porcelain', '-uall', '-z']);
  const generalEntries = parseStatusEntries(generalOutput);

  // 2. Fixture-store status including ignored files/directories matching .review-fixture-store
  const fixtureOutput = await git(cwd, [
    'status',
    '--porcelain',
    '-uall',
    '--ignored=traditional',
    '-z',
    '--',
    ':(glob)**/.review-fixture-store/**',
  ]);
  const fixtureEntries = parseStatusEntries(fixtureOutput);

  const seen = new Set<string>();
  const merged: StatusEntry[] = [];
  for (const entry of [...generalEntries, ...fixtureEntries]) {
    const key = `${entry.statusCode}\0${entry.path}\0${entry.origPath ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

/**
 * Restores modified/deleted tracked files and removes untracked/ignored scratch files
 * within fixture-store directories matching `.review-fixture-store`.
 * Unrelated files outside fixture-store directories are completely untouched.
 */
export const cleanReviewFixtureStore: CleanReviewFixtureStorePort = async (
  input: CleanReviewFixtureStoreInput,
): Promise<CleanReviewFixtureStoreResult> => {
  const { cwd, targetDirectories } = input;
  const resolvedCwd = resolve(cwd);

  let targets: string[] = [];
  const statusEntries = await collectFixtureStatusEntries(cwd);

  const explicitTargetsProvided = Boolean(targetDirectories && targetDirectories.length > 0);

  if (explicitTargetsProvided) {
    targets = Array.from(
      new Set<string>(targetDirectories!.map((t: string) => assertValidFixtureStoreTarget(cwd, t))),
    ).sort();
  } else {
    const discovered = new Set<string>();

    // 1. Auto-discover dirty/ignored fixture-store targets from status entries
    for (const entry of statusEntries) {
      const dir = extractFixtureStoreDir(entry.path);
      if (dir) {
        try {
          discovered.add(assertValidFixtureStoreTarget(cwd, dir));
        } catch {
          // ignore invalid targets
        }
      }
      if (entry.origPath) {
        const origDir = extractFixtureStoreDir(entry.origPath);
        if (origDir) {
          try {
            discovered.add(assertValidFixtureStoreTarget(cwd, origDir));
          } catch {
            // ignore invalid targets
          }
        }
      }
    }

    // 2. Discover existing fixture-store directories independently of status from the worktree
    const diskDirs = await findFixtureStoreDirectories(cwd);
    for (const diskDir of diskDirs) {
      discovered.add(diskDir);
    }

    targets = Array.from(discovered).sort();
  }

  if (targets.length === 0) {
    return {
      cleanedDirectories: [],
      restoredFiles: [],
      removedFiles: [],
    };
  }

  const allRestoredFiles: string[] = [];
  const allRemovedFiles: string[] = [];
  const cleanedDirectories: string[] = [];

  for (const targetDir of targets) {
    const matchingEntries = statusEntries.filter(
      (e) =>
        e.path === targetDir ||
        e.path.startsWith(`${targetDir}/`) ||
        (e.origPath && (e.origPath === targetDir || e.origPath.startsWith(`${targetDir}/`))),
    );

    // 1. Check if tracked files existed at HEAD under target directory
    const lsTree = await git(cwd, ['ls-tree', '-z', 'HEAD', '--', toLiteralGitPathspec(targetDir)]);

    const existedAtHead = lsTree.length > 0;

    // If auto-discovering and the target existed at HEAD with zero dirty/ignored entries,
    // it was already completely clean before cleanup — skip to avoid reporting clean dirs as cleaned.
    if (!explicitTargetsProvided && existedAtHead && matchingEntries.length === 0) {
      continue;
    }

    for (const entry of matchingEntries) {
      if (entry.statusCode === '??' || entry.statusCode === '!!') {
        allRemovedFiles.push(entry.path);
      } else if (entry.statusCode.startsWith('A') || entry.statusCode.endsWith('A')) {
        allRemovedFiles.push(entry.path);
      } else if (entry.statusCode.includes('M') || entry.statusCode.includes('D')) {
        allRestoredFiles.push(entry.path);
      } else if (entry.statusCode.includes('R')) {
        if (
          entry.origPath &&
          (entry.origPath === targetDir || entry.origPath.startsWith(`${targetDir}/`))
        ) {
          allRestoredFiles.push(entry.origPath);
        }
        allRemovedFiles.push(entry.path);
      }
    }

    // 2. Reset staged changes under target directory
    await git(cwd, ['reset', 'HEAD', '--', toLiteralGitPathspec(targetDir)]);

    if (existedAtHead) {
      // Restore tracked files from HEAD and remove untracked/ignored scratch files
      await git(cwd, ['checkout', 'HEAD', '--', toLiteralGitPathspec(targetDir)]);
      await git(cwd, ['clean', '-fdx', '--', toLiteralGitPathspec(targetDir)]);
    } else {
      // Directory did not exist at HEAD: clean and remove directory
      await git(cwd, ['clean', '-fdx', '--', toLiteralGitPathspec(targetDir)]);
      await rm(resolve(resolvedCwd, targetDir), { recursive: true, force: true });
    }

    // 3. Post-cleanup verification: target directory must be completely clean (including ignored files)
    const postStatus = await git(cwd, [
      'status',
      '--porcelain',
      '-uall',
      '--ignored=traditional',
      '-z',
      '--',
      toLiteralGitPathspec(targetDir),
    ]);

    if (postStatus.trim().length > 0) {
      throw new Error(
        `Review fixture-store cleanup failed: directory '${targetDir}' is still dirty after cleanup:\n${postStatus.trim()}`,
      );
    }

    cleanedDirectories.push(targetDir);
  }

  return {
    cleanedDirectories: Array.from(new Set(cleanedDirectories)).sort(),
    restoredFiles: Array.from(new Set(allRestoredFiles)).sort(),
    removedFiles: Array.from(new Set(allRemovedFiles)).sort(),
  };
};

import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  RevertProtectedFilesInput,
  RevertProtectedFilesResult,
} from '@ai-sdlc/application/ports';
import { git } from './git-runner.js';

/**
 * Reverts undeclared protected files to their pre-step baseline state,
 * untracks newly added files that become ignored after the restoration,
 * amends the current HEAD commit with `--no-edit`, and returns the amended SHA
 * along with sorted, deduplicated lists of repaired files.
 */
export async function revertProtectedFiles(
  input: RevertProtectedFilesInput,
): Promise<RevertProtectedFilesResult> {
  const { cwd, baseline } = input;

  const protectedPaths = Array.from(
    new Set(input.protectedFiles.map((p) => p.trim().replace(/\\/g, '/')).filter(Boolean)),
  ).sort();

  if (protectedPaths.length === 0) {
    const currentSha = await git(cwd, ['rev-parse', 'HEAD']);
    return {
      revertedProtectedFiles: [],
      removedNewlyIgnoredFiles: [],
      amendedHeadSha: currentSha,
    };
  }

  // 1. Capture files added in baseline..HEAD before mutating state
  const addedOutput = await git(cwd, [
    'diff',
    '--diff-filter=A',
    '--name-only',
    '-z',
    `${baseline}..HEAD`,
  ]);
  const stepAddedFiles = new Set(
    addedOutput
      .split('\0')
      .map((p) => p.trim().replace(/\\/g, '/'))
      .filter(Boolean),
  );

  // 2. Separate protected paths into baseline-existing vs baseline-absent
  const existingBaselinePaths: string[] = [];
  const absentBaselinePaths: string[] = [];

  for (const path of protectedPaths) {
    const lsTreeOutput = await git(cwd, ['ls-tree', '-z', baseline, '--', path]);
    if (lsTreeOutput.trim().length > 0) {
      existingBaselinePaths.push(path);
    } else {
      absentBaselinePaths.push(path);
    }
  }

  // 3. Restore baseline blobs for existing protected paths
  if (existingBaselinePaths.length > 0) {
    await git(cwd, ['checkout', baseline, '--', ...existingBaselinePaths]);
  }

  // 4. Remove Step-created protected files that did not exist at baseline
  for (const path of absentBaselinePaths) {
    try {
      await git(cwd, ['rm', '-rf', '--', path]);
    } catch {
      // Ignore if git rm fails (e.g. not tracked)
    }
    await rm(resolve(cwd, path), { recursive: true, force: true });
  }

  // 5. Query tracked ignored paths and untrack only those added in this Step
  const lsFilesIgnoredOutput = await git(cwd, ['ls-files', '-i', '-c', '--exclude-standard', '-z']);
  const trackedIgnoredPaths = lsFilesIgnoredOutput
    .split('\0')
    .map((p) => p.trim().replace(/\\/g, '/'))
    .filter(Boolean);

  const newlyIgnoredToUntrack = Array.from(
    new Set(trackedIgnoredPaths.filter((p) => stepAddedFiles.has(p))),
  ).sort();

  if (newlyIgnoredToUntrack.length > 0) {
    await git(cwd, ['rm', '--cached', '--', ...newlyIgnoredToUntrack]);
  }

  // 6. Amend HEAD with --no-edit and return the amended SHA
  await git(cwd, ['commit', '--amend', '--no-edit', '--allow-empty']);
  const amendedHeadSha = await git(cwd, ['rev-parse', 'HEAD']);

  return {
    revertedProtectedFiles: protectedPaths,
    removedNewlyIgnoredFiles: newlyIgnoredToUntrack,
    amendedHeadSha,
  };
}

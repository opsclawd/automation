import { rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { normalizeTaskPath } from '@ai-sdlc/domain';
import type { RevertScopeFilesInput, RevertScopeFilesResult } from '@ai-sdlc/application/ports';
import { git } from './git-runner.js';

/**
 * Reverts undeclared scope files/directories to their pre-step baseline state,
 * untracks newly added files that become ignored after the restoration,
 * amends the current HEAD commit with `--no-edit`, and returns the amended SHA
 * along with sorted, deduplicated lists of repaired files.
 */
export async function revertScopeFiles(
  input: RevertScopeFilesInput,
): Promise<RevertScopeFilesResult> {
  const { cwd, baseline, expectedHeadSha, rewriteSafety } = input;

  if (rewriteSafety !== 'unpublished') {
    throw new Error('Refusing to amend: rewriteSafety must be "unpublished"');
  }

  const currentHead = await git(cwd, ['rev-parse', 'HEAD']);
  if (currentHead !== expectedHeadSha) {
    throw new Error(
      `Refusing to amend: expected HEAD (${expectedHeadSha}) does not match current HEAD (${currentHead})`,
    );
  }

  const resolvedCwd = resolve(cwd);
  const normalizedPaths: string[] = [];

  for (const rawPath of input.scopeFiles) {
    const norm = normalizeTaskPath(rawPath);
    if (!norm) continue;
    const fullPath = resolve(resolvedCwd, norm);
    const rel = relative(resolvedCwd, fullPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Path ${rawPath} traverses outside working directory ${cwd}`);
    }
    normalizedPaths.push(norm);
  }

  const scopePaths = Array.from(new Set(normalizedPaths)).sort();

  if (scopePaths.length === 0) {
    return {
      revertedScopeFiles: [],
      removedNewlyIgnoredFiles: [],
      amendedHeadSha: currentHead,
    };
  }

  // 1. Capture files added in baseline..HEAD before mutating state
  const addedOutput = await git(cwd, [
    'diff',
    '--no-renames',
    '--diff-filter=A',
    '--name-only',
    '-z',
    `${baseline}..HEAD`,
  ]);
  const stepAddedFiles = new Set(addedOutput.split('\0').filter(Boolean));

  // 2. Separate scope paths into baseline-existing vs baseline-absent
  const existingBaselinePaths: string[] = [];
  const absentBaselinePaths: string[] = [];

  for (const path of scopePaths) {
    const lsTreeOutput = await git(cwd, ['ls-tree', '-z', baseline, '--', path]);
    if (lsTreeOutput.length > 0) {
      existingBaselinePaths.push(path);
    } else {
      absentBaselinePaths.push(path);
    }
  }

  // 3. Restore baseline blobs for existing scope paths
  if (existingBaselinePaths.length > 0) {
    await git(cwd, ['rm', '-rf', '--ignore-unmatch', '--', ...existingBaselinePaths]);
    await git(cwd, [
      'restore',
      `--source=${baseline}`,
      '--staged',
      '--worktree',
      '--',
      ...existingBaselinePaths,
    ]);
  }

  // 4. Remove Step-created scope files/directories that did not exist at baseline
  for (const path of absentBaselinePaths) {
    try {
      await git(cwd, ['rm', '-rf', '--ignore-unmatch', '--', path]);
    } catch {
      // Ignore if git rm fails (e.g. not tracked)
    }
    await rm(resolve(cwd, path), { recursive: true, force: true });
  }

  // 5. Query tracked ignored paths and untrack only those added in this Step
  const lsFilesIgnoredOutput = await git(cwd, ['ls-files', '-i', '-c', '--exclude-standard', '-z']);
  const trackedIgnoredPaths = lsFilesIgnoredOutput.split('\0').filter(Boolean);

  const newlyIgnoredToUntrack = Array.from(
    new Set(trackedIgnoredPaths.filter((p) => stepAddedFiles.has(p))),
  ).sort();

  if (newlyIgnoredToUntrack.length > 0) {
    await git(cwd, ['rm', '--cached', '--', ...newlyIgnoredToUntrack]);
  }

  // 6. Amend HEAD with --no-edit and return the amended SHA
  await git(cwd, ['commit', '--amend', '--no-edit', '--allow-empty']);
  const amendedHeadSha = await git(cwd, ['rev-parse', 'HEAD']);

  // 7. Verify all requested paths are absent from the repaired diff and status
  const diffOutput = await git(cwd, [
    'diff',
    '--no-renames',
    '--name-only',
    '-z',
    `${baseline}..${amendedHeadSha}`,
  ]);
  const diffFiles = diffOutput.split('\0').filter(Boolean);

  const statusOutput = await git(cwd, ['status', '--porcelain', '-z']);
  const statusEntries = statusOutput.split('\0').filter(Boolean);
  const statusFiles: string[] = [];
  for (let i = 0; i < statusEntries.length; i++) {
    const entry = statusEntries[i];
    if (!entry) continue;
    const statusCode = entry.slice(0, 2);
    const filePath = entry.slice(3);
    statusFiles.push(filePath);
    if (statusCode.startsWith('R') || statusCode.startsWith('C')) {
      // Rename or copy has original path in subsequent null-separated entry
      i++;
    }
  }

  const stillChangedPaths: string[] = [];
  for (const reqPath of scopePaths) {
    const inDiff = diffFiles.some((f) => f === reqPath || f.startsWith(`${reqPath}/`));
    const inStatus = statusFiles.some((f) => f === reqPath || f.startsWith(`${reqPath}/`));
    if (inDiff || inStatus) {
      stillChangedPaths.push(reqPath);
    }
  }

  if (stillChangedPaths.length > 0) {
    throw new Error(
      `Scope repair verification failed: paths still changed: ${stillChangedPaths.join(', ')}`,
    );
  }

  return {
    revertedScopeFiles: scopePaths,
    removedNewlyIgnoredFiles: newlyIgnoredToUntrack,
    amendedHeadSha,
  };
}

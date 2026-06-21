import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../git-runner.js';

const _tempDirs = new Set<string>();

/**
 * Returns a snapshot of all temp directories created by `makeTempRepo` that
 * have not yet been cleaned up. The returned array is a copy; mutations do
 * not affect the internal set.
 *
 * Use together with `clearTempDirs` in test lifecycle hooks:
 *
 * ```
 * const dirs = getTempDirs();
 * clearTempDirs();
 * await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
 * ```
 */
export function getTempDirs(): string[] {
  return [..._tempDirs];
}

/**
 * Empties the internal set of tracked temp directories.
 *
 * **WARNING:** Does NOT delete the directories themselves. Callers must
 * independently remove the directories returned by `getTempDirs` to avoid
 * leaking temporary storage on disk.
 */
export function clearTempDirs(): void {
  _tempDirs.clear();
}

export async function makeTempRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'ai-sdlc-git-'));
  _tempDirs.add(repoPath);
  try {
    await git(repoPath, ['init', '--initial-branch=main']);
    await git(repoPath, ['config', 'user.name', 'Test User']);
    await git(repoPath, ['config', 'user.email', 'test@example.com']);
    const readmePath = join(repoPath, 'README.md');
    await writeFile(readmePath, 'initial\n');
    await git(repoPath, ['add', '.']);
    await git(repoPath, ['commit', '-m', 'initial commit']);
    return repoPath;
  } catch (err) {
    _tempDirs.delete(repoPath);
    await rm(repoPath, { recursive: true, force: true });
    throw err;
  }
}

export async function makeRepoWithRemote(): Promise<{
  repo: string;
  bareRemote: string;
  branchSha: string;
}> {
  const repo = await makeTempRepo();
  const branchSha = await git(repo, ['rev-parse', 'HEAD']);
  const bareRemotePath = await mkdtemp(join(tmpdir(), 'ai-sdlc-bare-'));
  _tempDirs.add(bareRemotePath);
  await git(repo, ['init', '--bare', bareRemotePath]);
  await git(repo, ['remote', 'add', 'origin', bareRemotePath]);
  await git(repo, ['push', 'origin', 'main']);
  return { repo, bareRemote: bareRemotePath, branchSha };
}

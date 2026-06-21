import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../git-runner.js';

const _tempDirs = new Set<string>();

export function getTempDirs(): string[] {
  return [..._tempDirs];
}

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

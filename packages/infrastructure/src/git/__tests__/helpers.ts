import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../git-runner.js';

export async function makeTempRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'ai-sdlc-git-'));
  await git(repoPath, ['init', '--initial-branch=main']);
  await git(repoPath, ['config', 'user.name', 'Test User']);
  await git(repoPath, ['config', 'user.email', 'test@example.com']);
  const readmePath = join(repoPath, 'README.md');
  await writeFile(readmePath, 'initial\n');
  await git(repoPath, ['add', '.']);
  await git(repoPath, ['commit', '-m', 'initial commit']);
  return repoPath;
}

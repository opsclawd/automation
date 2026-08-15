import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitWorktreeAdapter } from '../git-worktree-adapter.js';
import { clearTempDirs, getTempDirs, makeTempRepo } from './helpers.js';

afterEach(async () => {
  const dirs = getTempDirs();
  clearTempDirs();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('GitWorktreeAdapter status untracked-path enumeration', () => {
  it('reports the file path for an untracked file inside a new directory', async () => {
    const repo = await makeTempRepo();
    const relativePath = 'docs/adr/0001-clean-architecture-boundaries.md';
    await mkdir(join(repo, 'docs', 'adr'), { recursive: true });
    await writeFile(join(repo, relativePath), '# Clean architecture boundaries\n');

    const result = await new GitWorktreeAdapter().status(repo);

    expect(result.split('\n')).toContain(`?? ${relativePath}`);
    expect(result.split('\n')).not.toContain('?? docs/adr/');
  });
});

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

  it('reports ignored files when includeIgnored option is enabled', async () => {
    const repo = await makeTempRepo();
    await writeFile(join(repo, '.gitignore'), '*.json\nnode_modules/\n');
    await writeFile(join(repo, 'fix-review-result.json'), '{"result":"done_with_fixes"}\n');
    await mkdir(join(repo, 'node_modules', 'foo'), { recursive: true });
    await writeFile(join(repo, 'node_modules', 'foo', 'index.js'), 'module.exports = 1;\n');

    const adapter = new GitWorktreeAdapter();
    const withoutIgnored = await adapter.status(repo);
    expect(withoutIgnored).not.toContain('fix-review-result.json');

    const withIgnored = await adapter.status(repo, { includeIgnored: true });
    const lines = withIgnored.split('\n');
    expect(lines).toContain('!! fix-review-result.json');
    expect(lines).toContain('!! node_modules/');
  });
});

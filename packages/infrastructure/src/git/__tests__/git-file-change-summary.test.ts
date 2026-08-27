import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitWorktreeAdapter } from '../git-worktree-adapter.js';
import { git } from '../git-runner.js';
import { getTempDirs, clearTempDirs, makeTempRepo } from './helpers.js';

afterEach(async () => {
  const dirs = getTempDirs();
  clearTempDirs();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('GitWorktreeAdapter.fileChangeSummary()', () => {
  const adapter = new GitWorktreeAdapter();

  it('returns a modified text summary with exact additions and deletions', async () => {
    const repo = await makeTempRepo();
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src/a.ts'), 'line 1\nline 2\nline 3\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'base commit']);
    const baseSha = await git(repo, ['rev-parse', 'HEAD']);

    // Modify src/a.ts: delete 1 line, add 2 lines
    await writeFile(join(repo, 'src/a.ts'), 'line 1\nline 2 changed\nline 2.5\nline 3\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'head commit']);
    const headSha = await git(repo, ['rev-parse', 'HEAD']);

    const summaries = await adapter.fileChangeSummary(repo, baseSha, headSha);
    expect(summaries).toEqual([
      {
        path: 'src/a.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
        binary: false,
      },
    ]);

    // Defaults head to HEAD when omitted
    const defaultSummaries = await adapter.fileChangeSummary(repo, baseSha);
    expect(defaultSummaries).toEqual(summaries);
  });

  it('classifies add delete rename copy and type change as ineligible statuses', async () => {
    const repo = await makeTempRepo();
    await writeFile(
      join(repo, 'to_rename.txt'),
      'line 1 of long file to rename\nline 2\nline 3\nline 4\nline 5\n',
    );
    await writeFile(join(repo, 'to_delete.txt'), 'content to delete\n');
    await writeFile(join(repo, 'to_typechange.txt'), 'regular file to become symlink\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'base commit']);
    const baseSha = await git(repo, ['rev-parse', 'HEAD']);

    // Head commit: add, delete, rename, copy, typechange
    await writeFile(join(repo, 'added.txt'), 'new file content\n');
    await git(repo, ['rm', 'to_delete.txt']);
    await git(repo, ['mv', 'to_rename.txt', 'renamed.txt']);
    await writeFile(
      join(repo, 'copied.txt'),
      'line 1 of long file to rename\nline 2\nline 3\nline 4\nline 5\n',
    );
    await rm(join(repo, 'to_typechange.txt'));
    await symlink('target', join(repo, 'to_typechange.txt'));

    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'head commit']);
    const headSha = await git(repo, ['rev-parse', 'HEAD']);

    const summaries = await adapter.fileChangeSummary(repo, baseSha, headSha);
    expect(summaries).toHaveLength(5);
    expect(summaries.some((s) => s.status === 'unknown')).toBe(false);

    const added = summaries.find((s) => s.path === 'added.txt');
    expect(added).toMatchObject({
      path: 'added.txt',
      status: 'added',
      additions: 1,
      deletions: 0,
      binary: false,
    });

    const deleted = summaries.find((s) => s.path === 'to_delete.txt');
    expect(deleted).toMatchObject({
      path: 'to_delete.txt',
      status: 'deleted',
      additions: 0,
      deletions: 1,
      binary: false,
    });

    const renamed = summaries.find((s) => s.path === 'renamed.txt');
    expect(renamed).toMatchObject({
      path: 'renamed.txt',
      status: 'renamed',
      oldPath: 'to_rename.txt',
      additions: 0,
      deletions: 0,
      binary: false,
    });

    const copied = summaries.find((s) => s.path === 'copied.txt');
    expect(copied).toMatchObject({
      path: 'copied.txt',
      status: 'copied',
      oldPath: 'to_rename.txt',
      additions: 0,
      deletions: 0,
      binary: false,
    });

    const typechanged = summaries.find((s) => s.path === 'to_typechange.txt');
    expect(typechanged).toMatchObject({
      path: 'to_typechange.txt',
      status: 'type_changed',
      binary: false,
    });
  });

  it('marks binary and unknown numstat evidence as non-narrow', async () => {
    const repo = await makeTempRepo();
    await writeFile(join(repo, 'binary.png'), Buffer.from([0, 1, 2, 3, 255, 254]));
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'base commit with binary']);
    const baseSha = await git(repo, ['rev-parse', 'HEAD']);

    await writeFile(join(repo, 'binary.png'), Buffer.from([0, 1, 2, 4, 255, 250, 100]));
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'head commit with modified binary']);
    const headSha = await git(repo, ['rev-parse', 'HEAD']);

    const summaries = await adapter.fileChangeSummary(repo, baseSha, headSha);
    expect(summaries).toEqual([
      {
        path: 'binary.png',
        status: 'modified',
        additions: null,
        deletions: null,
        binary: true,
      },
    ]);
  });

  it('preserves paths containing spaces through nul-delimited parsing', async () => {
    const repo = await makeTempRepo();
    const subfolder = join(repo, 'folder with spaces');
    await mkdir(subfolder, { recursive: true });
    await writeFile(join(subfolder, 'file with spaces.ts'), 'original line\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'base commit with spaced path']);
    const baseSha = await git(repo, ['rev-parse', 'HEAD']);

    await writeFile(join(subfolder, 'file with spaces.ts'), 'original line\nsecond line\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'head commit with modified spaced path']);
    const headSha = await git(repo, ['rev-parse', 'HEAD']);

    const summaries = await adapter.fileChangeSummary(repo, baseSha, headSha);
    expect(summaries).toEqual([
      {
        path: 'folder with spaces/file with spaces.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        binary: false,
      },
    ]);
  });
});

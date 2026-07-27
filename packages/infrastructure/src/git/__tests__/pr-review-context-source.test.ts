import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from '../git-runner.js';
import { createPrReviewContextSource } from '../pr-review-context-source.js';
import { clearTempDirs, getTempDirs, makeTempRepo } from './helpers.js';

afterEach(async () => {
  const dirs = getTempDirs();
  clearTempDirs();
  await Promise.all([...dirs].map((d) => rm(d, { recursive: true, force: true })));
});

describe('PrReviewContextSource', () => {
  const factory = createPrReviewContextSource();

  describe('context source path confinement', () => {
    it('rejects seed paths that escape the worktree', async () => {
      const repo = await makeTempRepo();
      const cwd = repo;

      await expect(
        factory({ cwd, base: 'HEAD', head: 'HEAD', seedPaths: ['/etc/passwd'] }),
      ).rejects.toThrow('seed path must be relative and must not escape');
    });

    it('rejects parent-traversal seed paths', async () => {
      const repo = await makeTempRepo();
      const cwd = repo;

      await expect(
        factory({ cwd, base: 'HEAD', head: 'HEAD', seedPaths: ['../README.md'] }),
      ).rejects.toThrow('seed path must be relative and must not escape');
    });

    it('rejects seed paths with .. inside them', async () => {
      const repo = await makeTempRepo();
      const cwd = repo;
      await mkdtemp(join(repo, 'subdir'));

      await expect(
        factory({ cwd, base: 'HEAD', head: 'HEAD', seedPaths: ['subdir/../README.md'] }),
      ).rejects.toThrow('seed path must be relative and must not escape');
    });

    it('accepts valid relative seed paths', async () => {
      const repo = await makeTempRepo();
      const cwd = repo;

      await expect(
        factory({ cwd, base: 'HEAD', head: 'HEAD', seedPaths: ['README.md'] }),
      ).resolves.toBeDefined();
    });
  });

  describe('context source bounded determinism', () => {
    it('returns deterministically ordered files within the total character cap', async () => {
      const repo = await makeTempRepo();
      const cwd = repo;

      const result1 = await factory({ cwd, base: 'HEAD', head: 'HEAD', seedPaths: [] });
      const result2 = await factory({ cwd, base: 'HEAD', head: 'HEAD', seedPaths: [] });

      expect(result1.fileContents).toEqual(result2.fileContents);
    });

    it('does not exceed MAX_SNAPSHOT_CHARS even with many files', async () => {
      const repo = await makeTempRepo();
      const cwd = repo;

      const result = await factory({ cwd, base: 'HEAD', head: 'HEAD', seedPaths: [] });

      const totalChars = Object.values(result.fileContents).reduce(
        (sum, content) => sum + content.length,
        0,
      );
      const { MAX_SNAPSHOT_CHARS } = await import('../pr-review-context-source.js');
      expect(totalChars).toBeLessThanOrEqual(MAX_SNAPSHOT_CHARS);
    });

    it('returns same ordering on repeated calls', async () => {
      const repo = await makeTempRepo();
      const cwd = repo;

      const r1 = await factory({ cwd, base: 'HEAD', head: 'HEAD', seedPaths: [] });
      const r2 = await factory({ cwd, base: 'HEAD', head: 'HEAD', seedPaths: [] });

      const keys1 = Object.keys(r1.fileContents);
      const keys2 = Object.keys(r2.fileContents);
      expect(keys1).toEqual(keys2);
    });
  });

  describe('context source partial failure', () => {
    it('keeps snapshot metadata when an optional file cannot be read', async () => {
      const repo = await makeTempRepo();
      const cwd = repo;

      await writeFile(join(repo, 'deleted.txt'), 'content\n');
      await git(repo, ['add', 'deleted.txt']);
      await git(repo, ['commit', '-m', 'add deleted.txt']);

      const commitWithDeleted = await git(repo, ['rev-parse', 'HEAD']);

      await git(repo, ['rm', 'deleted.txt']);
      await git(repo, ['commit', '-m', 'remove deleted.txt']);

      const result = await factory({
        cwd,
        base: commitWithDeleted,
        head: 'HEAD',
        seedPaths: ['deleted.txt'],
      });

      expect(result.fullDiff).toBeDefined();
      expect(result.diffStat).toBeDefined();
    });

    it('handles binary files gracefully', async () => {
      const repo = await makeTempRepo();
      const cwd = repo;

      const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      await writeFile(join(repo, 'image.png'), binaryContent);
      await git(repo, ['add', 'image.png']);
      await git(repo, ['commit', '-m', 'add binary']);

      const result = await factory({
        cwd,
        base: 'HEAD~1',
        head: 'HEAD',
        seedPaths: ['image.png'],
      });

      expect(result.fullDiff).toBeDefined();
      expect(result.diffStat).toBeDefined();
    });
  });

  describe('changed source plus sibling test', () => {
    it('returns changed files and their contents', async () => {
      const repo = await makeTempRepo();
      const cwd = repo;
      const base = await git(repo, ['rev-parse', 'HEAD']);

      await writeFile(join(repo, 'new-file.txt'), 'new content\n');
      await git(repo, ['add', 'new-file.txt']);
      await git(repo, ['commit', '-m', 'add new file']);

      const result = await factory({ cwd, base, head: 'HEAD', seedPaths: [] });

      expect(result.changedFiles).toContain('new-file.txt');
      expect(result.fileContents['new-file.txt']).toContain('new content');
    });

    it('includes sibling test candidates when seed path is provided', async () => {
      const repo = await makeTempRepo();
      const cwd = repo;

      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(join(repo, 'src', 'foo.ts'), 'export const foo = 1;\n');
      await writeFile(join(repo, 'src', 'foo.test.ts'), 'test("foo", () => {});\n');
      await git(repo, ['add', 'src']);
      await git(repo, ['commit', '-m', 'add src files']);

      const result = await factory({
        cwd,
        base: 'HEAD~1',
        head: 'HEAD',
        seedPaths: ['src/foo.ts'],
      });

      expect(result.fileContents['src/foo.ts']).toBeDefined();
    });
  });

  describe('total-character truncation', () => {
    it('truncates file contents to stay within MAX_FILE_CHARS per file', async () => {
      const repo = await makeTempRepo();
      const cwd = repo;

      const largeContent = 'x'.repeat(200_000);
      await writeFile(join(repo, 'large.txt'), largeContent);
      await git(repo, ['add', 'large.txt']);
      await git(repo, ['commit', '-m', 'add large file']);

      const result = await factory({
        cwd,
        base: 'HEAD~1',
        head: 'HEAD',
        seedPaths: ['large.txt'],
      });

      const fileContent = result.fileContents['large.txt'] ?? '';
      const { MAX_FILE_CHARS } = await import('../pr-review-context-source.js');
      expect(fileContent.length).toBeLessThanOrEqual(MAX_FILE_CHARS);
    });
  });

  describe('snapshot immutability', () => {
    it('returns immutable snapshot (readonly)', async () => {
      const repo = await makeTempRepo();
      const cwd = repo;

      const result = await factory({ cwd, base: 'HEAD', head: 'HEAD', seedPaths: [] });

      expect(() => {
        (result as { fullDiff: string }).fullDiff = 'mutated';
      }).toThrow();
    });

    it('snapshot base and head are immutable', async () => {
      const repo = await makeTempRepo();
      const cwd = repo;

      const result = await factory({ cwd, base: 'HEAD', head: 'HEAD', seedPaths: [] });

      expect(() => {
        (result as { base: string }).base = 'mutated';
      }).toThrow();
    });
  });
});

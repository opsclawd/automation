import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  cleanReviewFixtureStore,
  assertValidFixtureStoreTarget,
  extractFixtureStoreDir,
  findFixtureStoreDirectories,
} from '../clean-review-fixture-store.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function trackDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

function initRepo(): { repoDir: string; execGit: (args: string[]) => string } {
  const repoDir = trackDir(mkdtempSync(join(tmpdir(), 'clean-fixture-store-')));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repoDir], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], {
    stdio: 'pipe',
  });
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test User'], { stdio: 'pipe' });

  const execGit = (args: string[]) =>
    execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim();

  return { repoDir, execGit };
}

describe('cleanReviewFixtureStore', () => {
  describe('assertValidFixtureStoreTarget', () => {
    it('accepts valid repository-relative fixture store paths', () => {
      const cwd = '/repo';
      expect(assertValidFixtureStoreTarget(cwd, 'apps/orchestrator/.review-fixture-store')).toBe(
        'apps/orchestrator/.review-fixture-store',
      );
      expect(assertValidFixtureStoreTarget(cwd, '.review-fixture-store')).toBe(
        '.review-fixture-store',
      );
      expect(assertValidFixtureStoreTarget(cwd, './packages/pkg-a/.review-fixture-store/')).toBe(
        'packages/pkg-a/.review-fixture-store',
      );
    });

    it('rejects empty, traversal, or non-repository-relative targets', () => {
      const cwd = '/repo';
      expect(() => assertValidFixtureStoreTarget(cwd, '')).toThrow(/empty/i);
      expect(() => assertValidFixtureStoreTarget(cwd, '/abs/path/.review-fixture-store')).toThrow(
        /repository-relative/i,
      );
      expect(() => assertValidFixtureStoreTarget(cwd, '../outside/.review-fixture-store')).toThrow(
        /traverses outside/i,
      );
    });

    it('rejects lookalike directory names or files not named .review-fixture-store', () => {
      const cwd = '/repo';
      expect(() =>
        assertValidFixtureStoreTarget(cwd, 'apps/orchestrator/.review-fixture-store-backup'),
      ).toThrow(/target basename must be exactly '\.review-fixture-store'/i);
      expect(() => assertValidFixtureStoreTarget(cwd, 'src/review-fixture-store.ts')).toThrow(
        /target basename must be exactly '\.review-fixture-store'/i,
      );
      expect(() =>
        assertValidFixtureStoreTarget(
          cwd,
          'apps/orchestrator/.review-fixture-store/nested-file.json',
        ),
      ).toThrow(/target basename must be exactly '\.review-fixture-store'/i);
    });
  });

  describe('extractFixtureStoreDir', () => {
    it('extracts root directory segment matching .review-fixture-store', () => {
      expect(
        extractFixtureStoreDir('apps/orchestrator/.review-fixture-store/baselines/BASE-001.json'),
      ).toBe('apps/orchestrator/.review-fixture-store');
      expect(extractFixtureStoreDir('.review-fixture-store/seed.json')).toBe(
        '.review-fixture-store',
      );
      expect(extractFixtureStoreDir('packages/a/.review-fixture-store')).toBe(
        'packages/a/.review-fixture-store',
      );
      expect(
        extractFixtureStoreDir('src/.review-fixture-store-backup/something.json'),
      ).toBeUndefined();
      expect(extractFixtureStoreDir('src/review-fixture-store.ts')).toBeUndefined();
      expect(extractFixtureStoreDir('src/index.ts')).toBeUndefined();
    });
  });

  describe('findFixtureStoreDirectories', () => {
    it('discovers exact .review-fixture-store directories while skipping .git, node_modules, and lookalikes', async () => {
      const testDir = trackDir(mkdtempSync(join(tmpdir(), 'fixture-find-')));
      mkdirSync(join(testDir, 'apps/orchestrator/.review-fixture-store/nested'), {
        recursive: true,
      });
      mkdirSync(join(testDir, '.review-fixture-store'), { recursive: true });
      mkdirSync(join(testDir, 'packages/pkg-a/.review-fixture-store'), { recursive: true });
      mkdirSync(join(testDir, 'node_modules/dep/.review-fixture-store'), { recursive: true });
      mkdirSync(join(testDir, '.git/refs/.review-fixture-store'), { recursive: true });
      mkdirSync(join(testDir, '.ai-tmp/.review-fixture-store'), { recursive: true });
      mkdirSync(join(testDir, 'src/.review-fixture-store-backup'), { recursive: true });
      writeFileSync(join(testDir, 'src/review-fixture-store.ts'), 'export const a = 1;\n');

      const found = await findFixtureStoreDirectories(testDir);
      expect(found).toEqual([
        '.review-fixture-store',
        'apps/orchestrator/.review-fixture-store',
        'packages/pkg-a/.review-fixture-store',
      ]);
    });
  });

  describe('cleanup behavior in git repository', () => {
    it('restores tracked modified/deleted files and removes untracked scratch files under fixture-store', async () => {
      const { repoDir, execGit } = initRepo();
      const fixtureDir = join(repoDir, 'apps/orchestrator/.review-fixture-store');
      const baselinesDir = join(fixtureDir, 'baselines');
      mkdirSync(baselinesDir, { recursive: true });

      const base1Path = join(baselinesDir, 'BASE-001.json');
      const base2Path = join(baselinesDir, 'BASE-002.json');
      writeFileSync(base1Path, '{"id": "BASE-001", "v": 1}\n');
      writeFileSync(base2Path, '{"id": "BASE-002", "v": 1}\n');

      execGit(['add', '.']);
      execGit(['commit', '-m', 'chore: seed fixture store']);

      // Mutate tracked seed data: modify BASE-001, delete BASE-002
      writeFileSync(base1Path, '{"id": "BASE-001", "v": 2, "dirtied": true}\n');
      unlinkSync(base2Path);

      // Create untracked scratch files and directories
      const scratchDir = join(fixtureDir, 'scratch');
      mkdirSync(scratchDir, { recursive: true });
      const findingPath = join(scratchDir, 'FINDING-001.json');
      writeFileSync(findingPath, '{"finding": "test"}\n');

      const result = await cleanReviewFixtureStore({
        cwd: repoDir,
        targetDirectories: ['apps/orchestrator/.review-fixture-store'],
      });

      expect(result.cleanedDirectories).toEqual(['apps/orchestrator/.review-fixture-store']);
      expect(result.restoredFiles).toEqual([
        'apps/orchestrator/.review-fixture-store/baselines/BASE-001.json',
        'apps/orchestrator/.review-fixture-store/baselines/BASE-002.json',
      ]);
      expect(result.removedFiles).toEqual([
        'apps/orchestrator/.review-fixture-store/scratch/FINDING-001.json',
      ]);

      // Verify files in repository are clean
      expect(readFileSync(base1Path, 'utf8')).toBe('{"id": "BASE-001", "v": 1}\n');
      expect(existsSync(base2Path)).toBe(true);
      expect(readFileSync(base2Path, 'utf8')).toBe('{"id": "BASE-002", "v": 1}\n');
      expect(existsSync(findingPath)).toBe(false);
      expect(existsSync(scratchDir)).toBe(false);

      const status = execGit(['status', '--porcelain']);
      expect(status).toBe('');
    });

    it('preserves unrelated dirty tracked and untracked changes byte-for-byte', async () => {
      const { repoDir, execGit } = initRepo();
      const fixtureDir = join(repoDir, 'apps/orchestrator/.review-fixture-store');
      mkdirSync(fixtureDir, { recursive: true });

      const seedPath = join(fixtureDir, 'seed.json');
      writeFileSync(seedPath, '{"seed": "original"}\n');

      const unrelatedTracked = join(repoDir, 'src/index.ts');
      mkdirSync(join(repoDir, 'src'), { recursive: true });
      writeFileSync(unrelatedTracked, 'export const a = 1;\n');

      execGit(['add', '.']);
      execGit(['commit', '-m', 'chore: initial commit']);

      // Mutate fixture store
      writeFileSync(seedPath, '{"seed": "mutated by review harness"}\n');
      const scratchFixture = join(fixtureDir, 'harness-output.json');
      writeFileSync(scratchFixture, '{"log": "scratch"}\n');

      // Mutate unrelated tracked and create unrelated untracked
      const mutatedUnrelatedContent = 'export const a = 2; // user change\n';
      writeFileSync(unrelatedTracked, mutatedUnrelatedContent);

      const unrelatedUntracked = join(repoDir, 'unrelated-scratch.txt');
      const unrelatedUntrackedContent = 'important developer notes\n';
      writeFileSync(unrelatedUntracked, unrelatedUntrackedContent);

      const result = await cleanReviewFixtureStore({
        cwd: repoDir,
      });

      expect(result.cleanedDirectories).toEqual(['apps/orchestrator/.review-fixture-store']);
      expect(result.restoredFiles).toEqual(['apps/orchestrator/.review-fixture-store/seed.json']);
      expect(result.removedFiles).toEqual([
        'apps/orchestrator/.review-fixture-store/harness-output.json',
      ]);

      // Unrelated tracked modification is preserved byte-for-byte
      expect(readFileSync(unrelatedTracked, 'utf8')).toBe(mutatedUnrelatedContent);

      // Unrelated untracked file is preserved byte-for-byte
      expect(existsSync(unrelatedUntracked)).toBe(true);
      expect(readFileSync(unrelatedUntracked, 'utf8')).toBe(unrelatedUntrackedContent);

      // Fixture store is restored and clean
      expect(readFileSync(seedPath, 'utf8')).toBe('{"seed": "original"}\n');
      expect(existsSync(scratchFixture)).toBe(false);

      const statusLines = execGit(['status', '--short'])
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      expect(statusLines).toEqual(['M src/index.ts', '?? unrelated-scratch.txt']);
    });

    it('leaves similarly named backup directories and lookalike files untouched', async () => {
      const { repoDir, execGit } = initRepo();

      const fixtureDir = join(repoDir, 'apps/orchestrator/.review-fixture-store');
      mkdirSync(fixtureDir, { recursive: true });
      writeFileSync(join(fixtureDir, 'seed.json'), 'fixture-seed\n');

      const backupDir = join(repoDir, 'src/.review-fixture-store-backup');
      mkdirSync(backupDir, { recursive: true });
      const backupFile = join(backupDir, 'backup.json');
      writeFileSync(backupFile, 'backup-content\n');

      const lookalikeFile = join(repoDir, 'src/review-fixture-store.ts');
      writeFileSync(lookalikeFile, 'export const name = "test";\n');

      execGit(['add', '.']);
      execGit(['commit', '-m', 'chore: initial']);

      // Mutate all three
      writeFileSync(join(fixtureDir, 'seed.json'), 'fixture-mutated\n');
      writeFileSync(backupFile, 'backup-mutated\n');
      writeFileSync(lookalikeFile, 'export const name = "mutated";\n');

      const backupScratch = join(backupDir, 'backup-scratch.json');
      writeFileSync(backupScratch, 'backup-scratch\n');

      // Auto-discovery cleanup should only touch .review-fixture-store
      const result = await cleanReviewFixtureStore({ cwd: repoDir });

      expect(result.cleanedDirectories).toEqual(['apps/orchestrator/.review-fixture-store']);
      expect(result.restoredFiles).toEqual(['apps/orchestrator/.review-fixture-store/seed.json']);

      // Lookalike backup and file were NOT restored or cleaned
      expect(readFileSync(backupFile, 'utf8')).toBe('backup-mutated\n');
      expect(readFileSync(backupScratch, 'utf8')).toBe('backup-scratch\n');
      expect(readFileSync(lookalikeFile, 'utf8')).toBe('export const name = "mutated";\n');

      // Fixture store was restored
      expect(readFileSync(join(fixtureDir, 'seed.json'), 'utf8')).toBe('fixture-seed\n');
    });

    it('rejects invalid or traversal-containing targets without mutating the worktree', async () => {
      const { repoDir, execGit } = initRepo();
      const fixtureDir = join(repoDir, 'apps/orchestrator/.review-fixture-store');
      mkdirSync(fixtureDir, { recursive: true });
      const seedFile = join(fixtureDir, 'seed.json');
      writeFileSync(seedFile, 'initial\n');
      execGit(['add', '.']);
      execGit(['commit', '-m', 'init']);

      writeFileSync(seedFile, 'dirtied\n');

      await expect(
        cleanReviewFixtureStore({
          cwd: repoDir,
          targetDirectories: ['../outside/.review-fixture-store'],
        }),
      ).rejects.toThrow(/traverses outside/i);

      // Verify no mutation occurred
      expect(readFileSync(seedFile, 'utf8')).toBe('dirtied\n');

      await expect(
        cleanReviewFixtureStore({
          cwd: repoDir,
          targetDirectories: ['/etc/.review-fixture-store'],
        }),
      ).rejects.toThrow(/repository-relative/i);

      expect(readFileSync(seedFile, 'utf8')).toBe('dirtied\n');
    });

    it('propagates git failure if cleanup operation fails', async () => {
      await expect(
        cleanReviewFixtureStore({
          cwd: '/nonexistent-directory-path-12345',
          targetDirectories: ['apps/orchestrator/.review-fixture-store'],
        }),
      ).rejects.toThrow();
    });

    it('cleans dynamically created fixture-store directory that did not exist at HEAD', async () => {
      const { repoDir, execGit } = initRepo();
      writeFileSync(join(repoDir, 'root.txt'), 'root\n');
      execGit(['add', '.']);
      execGit(['commit', '-m', 'init']);

      // Harness dynamically created .review-fixture-store that was never in git
      const dynamicDir = join(repoDir, 'test/.review-fixture-store');
      mkdirSync(dynamicDir, { recursive: true });
      writeFileSync(join(dynamicDir, 'scratch.json'), 'dynamic\n');

      const result = await cleanReviewFixtureStore({ cwd: repoDir });

      expect(result.cleanedDirectories).toEqual(['test/.review-fixture-store']);
      expect(result.removedFiles).toEqual(['test/.review-fixture-store/scratch.json']);
      expect(existsSync(dynamicDir)).toBe(false);

      const status = execGit(['status', '--porcelain']);
      expect(status).toBe('');
    });

    it('returns empty result when worktree has no fixture store changes', async () => {
      const { repoDir, execGit } = initRepo();
      writeFileSync(join(repoDir, 'root.txt'), 'root\n');
      execGit(['add', '.']);
      execGit(['commit', '-m', 'init']);

      const result = await cleanReviewFixtureStore({ cwd: repoDir });
      expect(result).toEqual({
        cleanedDirectories: [],
        restoredFiles: [],
        removedFiles: [],
      });
    });

    it('removes ignored scratch files under fixture-store during auto-discovery when only ignored residue exists', async () => {
      const { repoDir, execGit } = initRepo();
      const fixtureDir = join(repoDir, 'apps/orchestrator/.review-fixture-store');
      mkdirSync(fixtureDir, { recursive: true });

      const seedPath = join(fixtureDir, 'seed.json');
      writeFileSync(seedPath, '{"seed": "original"}\n');

      // Add gitignore rule that covers .log files
      writeFileSync(join(repoDir, '.gitignore'), '*.log\n');

      execGit(['add', '.']);
      execGit(['commit', '-m', 'chore: initial commit with seed fixture and gitignore']);

      // Harness runs and creates ONLY an ignored file beneath fixture-store
      // Tracked seed files are NOT mutated
      const ignoredLogPath = join(fixtureDir, 'test-output.log');
      writeFileSync(ignoredLogPath, 'browser test log output\n');

      // Normal git status --porcelain -uall does not show ignoredLogPath
      expect(execGit(['status', '--porcelain', '-uall'])).toBe('');

      // Auto-discovery cleanup should discover the fixture store, clean it, and remove the ignored file
      const result = await cleanReviewFixtureStore({ cwd: repoDir });

      expect(result.cleanedDirectories).toEqual(['apps/orchestrator/.review-fixture-store']);
      expect(result.restoredFiles).toEqual([]);
      expect(result.removedFiles).toEqual([
        'apps/orchestrator/.review-fixture-store/test-output.log',
      ]);

      // Verify ignored file was removed from disk
      expect(existsSync(ignoredLogPath)).toBe(false);

      // Verify worktree is completely clean including ignored files
      const fullStatus = execGit(['status', '--porcelain', '-uall', '--ignored=traditional']);
      expect(fullStatus).toBe('');
    });

    it('returns empty result when tracked fixture store exists at HEAD but has no changes', async () => {
      const { repoDir, execGit } = initRepo();
      const fixtureDir = join(repoDir, 'apps/orchestrator/.review-fixture-store');
      mkdirSync(fixtureDir, { recursive: true });

      const seedPath = join(fixtureDir, 'seed.json');
      writeFileSync(seedPath, '{"seed": "clean"}\n');

      execGit(['add', '.']);
      execGit(['commit', '-m', 'chore: initial commit']);

      const result = await cleanReviewFixtureStore({ cwd: repoDir });
      expect(result).toEqual({
        cleanedDirectories: [],
        restoredFiles: [],
        removedFiles: [],
      });

      // Tracked seed remains untouched
      expect(readFileSync(seedPath, 'utf8')).toBe('{"seed": "clean"}\n');
    });
  });
});

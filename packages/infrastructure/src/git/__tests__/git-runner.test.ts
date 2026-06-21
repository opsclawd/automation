import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { git, GitFailedError } from '../git-runner.js';
import { getTempDirs, clearTempDirs, makeTempRepo } from './helpers.js';

afterEach(async () => {
  const dirs = getTempDirs();
  clearTempDirs();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('git()', () => {
  it('returns trimmed stdout for a successful command', async () => {
    const repoPath = await makeTempRepo();

    const result = await git(repoPath, ['log', '--format=%s', '-1']);
    expect(result).toBe('initial commit');
  });

  it('rejects with GitFailedError on non-zero exit', async () => {
    const repoPath = await makeTempRepo();

    await expect(git(repoPath, ['show', 'nonexistent-ref'])).rejects.toThrow(GitFailedError);
    await expect(git(repoPath, ['show', 'nonexistent-ref'])).rejects.toMatchObject({
      stderr: expect.stringContaining('fatal'),
    });
  });

  it('trims leading and trailing whitespace from stdout', async () => {
    const repoPath = await makeTempRepo();

    const result = await git(repoPath, ['rev-parse', 'HEAD']);
    expect(result).toMatch(/^[0-9a-f]{40}$/);
  });

  it('rejects when command exceeds timeout', { timeout: 15_000 }, async () => {
    const repoPath = await makeTempRepo();

    await expect(git(repoPath, ['-c', 'alias.sleep=!sleep 10', 'sleep'], 50)).rejects.toMatchObject({ timedOut: true });
  });
});

describe('makeTempRepo()', () => {
  it('creates a directory that is a valid git repo', async () => {
    const repoPath = await makeTempRepo();

    const result = await git(repoPath, ['rev-parse', '--git-dir']);
    expect(result).toBe('.git');
  });

  it('initialises with one commit on main branch', async () => {
    const repoPath = await makeTempRepo();

    const branch = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(branch).toBe('main');

    const log = await git(repoPath, ['log', '--oneline']);
    const lines = log.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it('is isolated from the project repo (different directory)', async () => {
    const repoPath = await makeTempRepo();

    expect(repoPath).not.toBe(process.cwd());
    expect(repoPath.startsWith(tmpdir())).toBe(true);
  });
});

describe('helper functions', () => {
  it('getTempDirs returns snapshot of tracked directories', async () => {
    expect(getTempDirs()).toEqual([]);
    const repoPath = await makeTempRepo();
    expect(getTempDirs()).toContain(repoPath);
  });

  it('clearTempDirs empties the set', async () => {
    const repoPath = await makeTempRepo();
    expect(getTempDirs()).toContain(repoPath);
    clearTempDirs();
    expect(getTempDirs()).toEqual([]);
  });
});

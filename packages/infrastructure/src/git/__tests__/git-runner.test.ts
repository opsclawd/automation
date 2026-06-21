import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from '../git-runner.js';
import { makeTempRepo } from './helpers.js';

let tempRepos: string[] = [];

afterEach(async () => {
  const dirs = tempRepos.splice(0);
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('git()', () => {
  it('returns trimmed stdout for a successful command', async () => {
    const repoPath = await makeTempRepo();
    tempRepos.push(repoPath);

    const result = await git(repoPath, ['log', '--oneline', '-1']);
    expect(result).toBeTruthy();
    expect(result).not.toMatch(/\n$/);
  });

  it('rejects when git exits with a non-zero code', async () => {
    const repoPath = await makeTempRepo();
    tempRepos.push(repoPath);

    await expect(git(repoPath, ['show', 'nonexistent-ref'])).rejects.toThrow();
  });

  it('trims leading and trailing whitespace from stdout', async () => {
    const repoPath = await makeTempRepo();
    tempRepos.push(repoPath);

    const result = await git(repoPath, ['rev-parse', 'HEAD']);
    expect(result).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('makeTempRepo()', () => {
  it('creates a directory that is a valid git repo', async () => {
    const repoPath = await makeTempRepo();
    tempRepos.push(repoPath);

    const result = await git(repoPath, ['rev-parse', '--git-dir']);
    expect(result).toBe('.git');
  });

  it('initialises with one commit on main branch', async () => {
    const repoPath = await makeTempRepo();
    tempRepos.push(repoPath);

    const branch = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(branch).toBe('main');

    const log = await git(repoPath, ['log', '--oneline']);
    const lines = log.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it('is isolated from the project repo (different directory)', async () => {
    const repoPath = await makeTempRepo();
    tempRepos.push(repoPath);

    expect(repoPath).not.toBe(process.cwd());
    expect(repoPath).toMatch(/tmp/);
  });
});

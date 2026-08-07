import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeGitPort } from '@ai-sdlc/application/test-doubles';
import { git } from '../git-runner.js';
import { GitWorktreeAdapter } from '../git-worktree-adapter.js';
import { clearTempDirs, getTempDirs, makeTempRepo } from './helpers.js';

afterEach(async () => {
  const dirs = getTempDirs();
  clearTempDirs();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const adapter = new GitWorktreeAdapter();

describe('amendCommitMessage()', () => {
  it('amends the HEAD message without changing committed content', async () => {
    const repo = await makeTempRepo();
    const filePath = join(repo, 'feature.txt');
    await writeFile(filePath, 'feature content\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'feat: add feature']);

    const originalSha = await git(repo, ['rev-parse', 'HEAD']);
    const amendedSha = await adapter.amendCommitMessage(
      repo,
      'fix(review): address scoped finding',
    );

    expect(amendedSha).not.toBe(originalSha);
    expect(await git(repo, ['log', '-1', '--format=%s'])).toBe(
      'fix(review): address scoped finding',
    );
    expect(await git(repo, ['status', '--porcelain'])).toBe('');

    const content = await readFile(filePath, 'utf8');
    expect(content).toBe('feature content\n');
  });

  it('passes a multiline amendment message as one git argument', async () => {
    const repo = await makeTempRepo();
    const multilineMsg = 'fix(review): address scoped finding\n\n- detail 1\n- detail 2';
    const originalSha = await git(repo, ['rev-parse', 'HEAD']);

    const amendedSha = await adapter.amendCommitMessage(repo, multilineMsg);

    expect(amendedSha).not.toBe(originalSha);
    const body = await git(repo, ['log', '-1', '--format=%B']);
    expect(body.trim()).toBe(multilineMsg);
    expect(await git(repo, ['status', '--porcelain'])).toBe('');
  });
});

describe('FakeGitPort.amendCommitMessage()', () => {
  it('updates most recent fake commit message by replacing HEAD commit', async () => {
    const fakeGit = new FakeGitPort();
    const originalSha = await fakeGit.commit('/test', 'original message');
    expect(fakeGit.commits).toHaveLength(1);
    expect(fakeGit.commits[0]?.message).toBe('original message');
    expect(fakeGit.commits[0]?.sha).toBe(originalSha);

    const amendedSha = await fakeGit.amendCommitMessage('/test', 'amended message');

    expect(amendedSha).not.toBe(originalSha);
    expect(await fakeGit.headCommitSha('/test')).toBe(amendedSha);
    expect(fakeGit.commits).toHaveLength(1);
    expect(fakeGit.commits[0]?.message).toBe('amended message');
    expect(fakeGit.commits[0]?.sha).toBe(amendedSha);
  });
});

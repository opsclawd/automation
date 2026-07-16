import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { GhCliAdapter } from '../gh-cli-adapter.js';
import { GitHubFailedError } from '../errors.js';

const fixtures = join(fileURLToPath(new URL('.', import.meta.url)), '..', '__fixtures__');
const ok = new GhCliAdapter({ ghPath: join(fixtures, 'fake-gh-success.sh'), maxRetries: 0 });
const bad = new GhCliAdapter({
  ghPath: join(fixtures, 'fake-gh-fail.sh'),
  maxRetries: 1,
  backoffMs: 1,
});

describe('GhCliAdapter reads', () => {
  it('parses an issue', async () => {
    const issue = await ok.getIssue('o/r', 7);
    expect(issue.title).toBe('T');
    expect(issue.labels).toEqual(['bug']);
  });

  it('parses issue comments from REST shape', async () => {
    const cs = await ok.listIssueComments('o/r', 7);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toEqual({
      id: 9001,
      author: 'octocat',
      body: 'issue comment body',
      createdAt: new Date('2026-06-04T00:00:00Z'),
    });
  });

  it('parses PR metadata and normalises state to lowercase', async () => {
    const pr = await ok.getPr('o/r', 5);
    expect(pr.headRefName).toBe('feat-x');
    expect(pr.state).toBe('open');
  });

  it('maps review comments from REST shape', async () => {
    const cs = await ok.listReviewComments('o/r', 5);
    expect(cs[0]).toMatchObject({ id: 9001, path: 'a.ts', reviewer: 'octocat' });
    expect(cs[0].inReplyToId).toBeUndefined();
  });

  it('throws GitHubFailedError after retries exhausted', async () => {
    await expect(bad.getIssue('o/r', 7)).rejects.toBeInstanceOf(GitHubFailedError);
  });
});

describe('GhCliAdapter writes', () => {
  it('posts a reply via the REST replies endpoint and returns the created comment', async () => {
    const log = join(tmpdir(), `gh-log-${Date.now()}.txt`);
    writeFileSync(log, '');
    try {
      const adapter = new GhCliAdapter({
        ghPath: join(fixtures, 'fake-gh-success.sh'),
        maxRetries: 0,
        env: { FAKE_GH_LOG: log },
      });
      const res = await adapter.replyToReviewComment('o/r', 5, 9001, 'thanks');
      expect(res).toEqual({
        id: 9002,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'thanks',
        createdAt: new Date('2026-06-04T00:00:00Z'),
        inReplyToId: 9001,
      });
      const calls = readFileSync(log, 'utf-8');
      expect(calls).toContain('api repos/o/r/pulls/5/comments/9001/replies --method POST');
    } finally {
      rmSync(log, { force: true });
    }
  });

  it('resolves a review thread via graphql', async () => {
    const adapter = new GhCliAdapter({
      ghPath: join(fixtures, 'fake-gh-success.sh'),
      maxRetries: 0,
    });
    await expect(adapter.resolveReviewThread('o/r', 5, 9001)).resolves.toBeUndefined();
  });

  it('updates issue labels', async () => {
    const adapter = new GhCliAdapter({
      ghPath: join(fixtures, 'fake-gh-success.sh'),
      maxRetries: 0,
    });
    await expect(
      adapter.updateIssueLabels('o/r', 7, { add: ['ai:pr-ready'], remove: ['ai:in-progress'] }),
    ).resolves.toBeUndefined();
  });

  it('creates a PR and returns the parsed number', async () => {
    const adapter = new GhCliAdapter({
      ghPath: join(fixtures, 'fake-gh-success.sh'),
      maxRetries: 0,
    });
    const pr = await adapter.createPullRequest({
      repoFullName: 'o/r',
      baseBranch: 'main',
      headBranch: 'feat-x',
      title: 'T',
      body: 'B',
    });
    expect(pr.number).toBe(99);
    expect(pr.state).toBe('open');
  });
});

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

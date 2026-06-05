import { describe, it, expect } from 'vitest';
import { FakeGitHubPort } from '../test-doubles/fake-github-port.js';

describe('FakeGitHubPort (extended for M6)', () => {
  it('returns PR metadata via getPr', async () => {
    const gh = new FakeGitHubPort();
    gh.prs.set('o/r/5', { number: 5, url: 'https://x/pr/5', state: 'open', headRefName: 'feat-x' });
    const pr = await gh.getPr('o/r', 5);
    expect(pr.headRefName).toBe('feat-x');
    expect(pr.state).toBe('open');
  });

  it('records resolved threads', async () => {
    const gh = new FakeGitHubPort();
    await gh.resolveReviewThread('o/r', 5, 9001);
    expect(gh.resolvedThreads).toContainEqual({
      repoFullName: 'o/r',
      prNumber: 5,
      commentId: 9001,
    });
  });
});

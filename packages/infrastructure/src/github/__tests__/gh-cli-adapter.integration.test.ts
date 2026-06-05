import { describe, it, expect, beforeAll } from 'vitest';
import { GhCliAdapter } from '../gh-cli-adapter.js';

const run = process.env.GH_INTEGRATION === '1' ? describe : describe.skip;

run('GhCliAdapter against real gh', () => {
  beforeAll(() => {
    if (!process.env.GH_TEST_REPO || !process.env.GH_TEST_ISSUE) {
      throw new Error(
        'Integration tests require GH_TEST_REPO and GH_TEST_ISSUE environment variables',
      );
    }
  });

  it('reads a known public issue', async () => {
    const adapter = new GhCliAdapter({});
    const issue = await adapter.getIssue(
      process.env.GH_TEST_REPO!,
      Number(process.env.GH_TEST_ISSUE),
    );
    expect(issue.number).toBeGreaterThan(0);
  });
});

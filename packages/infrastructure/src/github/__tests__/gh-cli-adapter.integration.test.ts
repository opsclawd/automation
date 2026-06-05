import { describe, it, expect } from 'vitest';
import { GhCliAdapter } from '../gh-cli-adapter.js';

const run = process.env.GH_INTEGRATION === '1' ? describe : describe.skip;

run('GhCliAdapter against real gh', () => {
  it('reads a known public issue', async () => {
    const adapter = new GhCliAdapter({});
    const issue = await adapter.getIssue(
      process.env.GH_TEST_REPO!,
      Number(process.env.GH_TEST_ISSUE),
    );
    expect(issue.number).toBeGreaterThan(0);
  });
});

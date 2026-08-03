import { describe, it, expect } from 'vitest';
import { getPostPrReviewCommitPolicy } from '../prompts/constants.js';
import { getGitCommitExcludePathspecs } from '../artifacts/orchestrator-artifacts.js';

describe('post-pr-review commit policy', () => {
  const exclusions = getGitCommitExcludePathspecs();

  it('single-comment policy excludes orchestrator artifacts from staging and cleanliness checks', () => {
    const policy = getPostPrReviewCommitPolicy(false);
    expect(policy).toContain('git add -A -- .');
    expect(policy).toContain('git status --porcelain -- .');
    for (const exclusion of exclusions) expect(policy).toContain(exclusion);
    expect(policy).toContain('git commit -m "fix: address PR review feedback"');
    expect(policy).not.toContain('git add -A && git commit -m "fix: address PR review feedback"');
  });

  it('batch-comment policy preserves multi-file staging with the same exclusions', () => {
    const policy = getPostPrReviewCommitPolicy(true);
    expect(policy).toContain('git add -A -- .');
    expect(policy).toContain('git status --porcelain -- .');
    for (const exclusion of exclusions) expect(policy).toContain(exclusion);
    expect(policy).toContain('git commit -m "fix: address PR review feedback"');
    expect(policy).not.toContain('git add -A && git commit -m "fix: address PR review feedback"');
  });

  it('policy no longer emits a bare git add -A commit command', () => {
    const policySingle = getPostPrReviewCommitPolicy(false);
    const policyBatch = getPostPrReviewCommitPolicy(true);
    expect(policySingle).not.toContain(
      'git add -A && git commit -m "fix: address PR review feedback"',
    );
    expect(policyBatch).not.toContain(
      'git add -A && git commit -m "fix: address PR review feedback"',
    );
  });
});

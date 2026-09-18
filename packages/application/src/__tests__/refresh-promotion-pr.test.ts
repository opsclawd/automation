import { describe, it, expect, beforeEach } from 'vitest';
import { ReleaseBatchId, RepositoryId, createReleaseBatch } from '@ai-sdlc/domain';
import { refreshPromotionPrBody, refreshPromotionPr } from '../refresh-promotion-pr.js';
import { FakeGitHubPort } from '../test-doubles/fake-github-port.js';

describe('refreshPromotionPrBody', () => {
  it('updates mechanical fields in rich assembled PR markdown while preserving narrative sections', () => {
    const originalBody = `## Release Promotion: \`batch-123\`

| Property | Value |
| :--- | :--- |
| **Release Branch** | \`release/batch-123\` |
| **Target Branch** | \`main\` |
| **Candidate SHA** | \`old-sha-111\` |
| **Included Issues** | 2 |
| **Status** | Awaiting Operator Review |

### Overview & Cumulative Architecture

This pull request promotes autonomous release batch \`batch-123\` into \`main\`.
Custom architectural commentary authored by operator.

### Included Issues

- #10 - **First Feature**
- #20 - **Second Feature**

### Verification & Test Results

- All batch items were sequentially admitted, verified, and merged into \`release/batch-123\`:
- Position 1: Issue #10 - status: \`merged\` (merged at \`sha-10\`)
- Position 2: Issue #20 - status: \`merged\` (merged at \`sha-20\`)
- Release candidate commit \`old-sha-111\` contains all constituent merge commits.
- Branch ancestry and drift validations confirmed no conflicting modifications against \`main\`.

> [!IMPORTANT]
> **Safety Default**: Auto-merge is disabled on this promotion PR.

### Linked Issues

Closes #10
Closes #20`;

    const refreshed = refreshPromotionPrBody(originalBody, 'new-candidate-sha-999', [10, 20, 30]);

    // Candidate SHA in table updated
    expect(refreshed).toContain('| **Candidate SHA** | `new-candidate-sha-999` |');
    expect(refreshed).not.toContain('`old-sha-111`');

    // Included Issues count in table updated
    expect(refreshed).toContain('| **Included Issues** | 3 |');

    // Release candidate commit sentence updated
    expect(refreshed).toContain(
      '- Release candidate commit `new-candidate-sha-999` contains all constituent merge commits.',
    );

    // Linked Issues section updated with new issue #30
    expect(refreshed).toContain('### Linked Issues\n\nCloses #10\nCloses #20\nCloses #30');

    // Narrative text preserved
    expect(refreshed).toContain('Custom architectural commentary authored by operator.');
    expect(refreshed).toContain(
      '> **Safety Default**: Auto-merge is disabled on this promotion PR.',
    );
    expect(refreshed).toContain('- Position 1: Issue #10 - status: `merged`');
  });

  it('updates mechanical fields in simple / legacy PR markdown', () => {
    const originalBody = `Autonomous release batch promotion for batch-123.
Approved Candidate SHA: \`old-sha-111\`

Closes #10
Closes #20`;

    const refreshed = refreshPromotionPrBody(originalBody, 'new-candidate-sha-999', [10, 20, 30]);

    expect(refreshed).toBe(`Autonomous release batch promotion for batch-123.
Approved Candidate SHA: \`new-candidate-sha-999\`

Closes #10
Closes #20
Closes #30`);
  });

  it('appends candidate SHA and Linked Issues when completely absent from custom body', () => {
    const originalBody = `Manual promotion description with no mechanical tags.`;

    const refreshed = refreshPromotionPrBody(originalBody, 'new-sha-123', [5, 6]);

    expect(refreshed).toContain('Manual promotion description with no mechanical tags.');
    expect(refreshed).toContain('Approved Candidate SHA: `new-sha-123`');
    expect(refreshed).toContain('### Linked Issues\n\nCloses #5\nCloses #6');
  });

  it('handles empty body gracefully', () => {
    const refreshed = refreshPromotionPrBody('', 'sha-empty', [42]);

    expect(refreshed).toContain('Approved Candidate SHA: `sha-empty`');
    expect(refreshed).toContain('Closes #42');
  });
});

describe('refreshPromotionPr', () => {
  let github: FakeGitHubPort;
  const repoFullName = 'test-org/test-repo';

  beforeEach(() => {
    github = new FakeGitHubPort();
  });

  function createBatch(issueNumbers: number[]) {
    return createReleaseBatch({
      id: ReleaseBatchId('batch-promo-001'),
      repoId: RepositoryId('test-org/test-repo'),
      sourceBranch: 'main',
      sourceStartSha: 'sha-main-start',
      releaseBranch: 'release/batch-promo-001',
      items: issueNumbers.map((num, idx) => ({ position: idx + 1, issueNumber: num })),
      createdAt: new Date(),
    });
  }

  it('updates PR body and title when title matches default prefix', async () => {
    // Setup initial PR in fake GitHub
    const pr = await github.createPullRequest({
      repoFullName,
      baseBranch: 'main',
      headBranch: 'release/batch-promo-001',
      title: 'Release batch-promo-001: #101',
      body: 'Autonomous release batch promotion for batch-promo-001.\nApproved Candidate SHA: `sha-1`\n\nCloses #101',
    });

    const batch = {
      ...createBatch([101, 102]),
      promotionPrNumber: pr.number,
      approvedCandidateSha: 'sha-2',
    };

    await refreshPromotionPr({
      github,
      repoFullName,
      prNumber: pr.number,
      batch,
      candidateSha: 'sha-2',
    });

    expect(github.updatedPrInputs).toHaveLength(1);
    expect(github.updatedPrInputs[0]?.title).toBe('Release batch-promo-001: #101, #102');
    expect(github.updatedPrInputs[0]?.body).toContain('Approved Candidate SHA: `sha-2`');
    expect(github.updatedPrInputs[0]?.body).toContain('Closes #101\nCloses #102');

    const updatedPr = await github.getPr(repoFullName, pr.number);
    expect(updatedPr.title).toBe('Release batch-promo-001: #101, #102');
    expect(updatedPr.body).toContain('Approved Candidate SHA: `sha-2`');
    expect(updatedPr.body).toContain('Closes #101\nCloses #102');
  });

  it('does not overwrite title if title was customized by operator', async () => {
    const pr = await github.createPullRequest({
      repoFullName,
      baseBranch: 'main',
      headBranch: 'release/batch-promo-001',
      title: 'Custom operator title for release batch',
      body: 'Approved Candidate SHA: `sha-1`\n\nCloses #101',
    });

    const batch = {
      ...createBatch([101, 102]),
      promotionPrNumber: pr.number,
      approvedCandidateSha: 'sha-2',
    };

    await refreshPromotionPr({
      github,
      repoFullName,
      prNumber: pr.number,
      batch,
      candidateSha: 'sha-2',
    });

    expect(github.updatedPrInputs).toHaveLength(1);
    expect(github.updatedPrInputs[0]?.title).toBeUndefined();
    expect(github.updatedPrInputs[0]?.body).toContain('Approved Candidate SHA: `sha-2`');

    const updatedPr = await github.getPr(repoFullName, pr.number);
    expect(updatedPr.title).toBe('Custom operator title for release batch');
  });

  it('is a no-op when PR title and body are already up to date', async () => {
    const pr = await github.createPullRequest({
      repoFullName,
      baseBranch: 'main',
      headBranch: 'release/batch-promo-001',
      title: 'Release batch-promo-001: #101',
      body: 'Autonomous release batch promotion for batch-promo-001.\nApproved Candidate SHA: `sha-1`\n\nCloses #101',
    });

    const batch = {
      ...createBatch([101]),
      promotionPrNumber: pr.number,
      approvedCandidateSha: 'sha-1',
    };

    await refreshPromotionPr({
      github,
      repoFullName,
      prNumber: pr.number,
      batch,
      candidateSha: 'sha-1',
    });

    expect(github.updatedPrInputs).toHaveLength(0);
  });
});

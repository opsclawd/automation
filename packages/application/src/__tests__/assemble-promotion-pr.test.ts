import { describe, it, expect } from 'vitest';
import {
  ReleaseBatchId,
  RepositoryId,
  createReleaseBatch,
  admitItem,
  markItemMerged,
} from '@ai-sdlc/domain';
import { assemblePromotionPr } from '../assemble-promotion-pr.js';
import { FakeGitHubPort } from '../test-doubles/fake-github-port.js';
import { FakeGitPort } from '../test-doubles/fake-git-port.js';

describe('assemblePromotionPr', () => {
  const repoFullName = 'opsclawd/automation';
  const t0 = new Date('2026-09-11T12:00:00.000Z');

  function createTestBatch(issueNumbers: number[]) {
    let batch = createReleaseBatch({
      id: ReleaseBatchId('batch-sample-123'),
      repoId: RepositoryId(repoFullName),
      sourceBranch: 'main',
      sourceStartSha: 'sha-main-start',
      releaseBranch: 'release/batch-sample-123',
      createdAt: t0,
      items: issueNumbers.map((num, idx) => ({ position: idx + 1, issueNumber: num })),
    });

    for (let pos = 1; pos <= issueNumbers.length; pos++) {
      batch = admitItem(batch, pos, { runUuid: `run-${pos}`, now: t0 });
      batch = markItemMerged(batch, pos, {
        mergedCommitSha: `sha-commit-${100 + pos}`,
        now: t0,
      });
    }

    return batch;
  }

  it('generates title, narrative, metadata, and Closes lines for all issues', async () => {
    const batch = createTestBatch([101, 102, 103]);
    const github = new FakeGitHubPort();
    github.issues.set(`${repoFullName}/101`, {
      number: 101,
      title: 'Fix edge case in token bucket',
      body: 'Details 101',
      labels: ['bug', 'priority:high'],
    });
    github.issues.set(`${repoFullName}/102`, {
      number: 102,
      title: 'Add metrics endpoint',
      body: 'Details 102',
      labels: ['enhancement'],
    });
    // 103 will simulate missing from github / fallback

    const git = new FakeGitPort();
    git.logBetweenResults.set('sha-main-start|sha-candidate-999', [
      'commit 1: Fix edge case in token bucket (#101)',
      'commit 2: Add metrics endpoint (#102)',
      'commit 3: Update documentation (#103)',
    ]);

    const result = await assemblePromotionPr({
      batch,
      repoFullName,
      candidateSha: 'sha-candidate-999',
      localBasePath: '/tmp/repo',
      github,
      git,
    });

    // Title
    expect(result.title).toBe('Release batch-sample-123: #101, #102, #103');

    // Body content checks
    expect(result.body).toContain('## Release Promotion: `batch-sample-123`');
    expect(result.body).toContain('| **Release Branch** | `release/batch-sample-123` |');
    expect(result.body).toContain('| **Target Branch** | `main` |');
    expect(result.body).toContain('| **Candidate SHA** | `sha-candidate-999` |');

    // Issue summaries
    expect(result.body).toContain(
      '- #101 - **Fix edge case in token bucket** `[bug, priority:high]`',
    );
    expect(result.body).toContain('- #102 - **Add metrics endpoint** `[enhancement]`');
    expect(result.body).toContain('- #103'); // fallback without title

    // Git commits
    expect(result.body).toContain('commit 1: Fix edge case in token bucket (#101)');
    expect(result.body).toContain('commit 2: Add metrics endpoint (#102)');
    expect(result.body).toContain('commit 3: Update documentation (#103)');

    // Safety notice
    expect(result.body).toContain('Auto-merge is disabled on this promotion PR.');

    // Closes references
    expect(result.body).toContain('Closes #101');
    expect(result.body).toContain('Closes #102');
    expect(result.body).toContain('Closes #103');
  });

  it('works without optional github and git ports', async () => {
    const batch = createTestBatch([201, 202]);
    const result = await assemblePromotionPr({
      batch,
      repoFullName,
      candidateSha: 'sha-candidate-fallback',
    });

    expect(result.title).toBe('Release batch-sample-123: #201, #202');
    expect(result.body).toContain('- #201');
    expect(result.body).toContain('- #202');
    expect(result.body).toContain('Closes #201');
    expect(result.body).toContain('Closes #202');
    expect(result.body).toContain('Candidate SHA');
    expect(result.body).toContain('`sha-candidate-fallback`');
  });

  it('truncates body if it exceeds 60,000 characters while preserving Closes lines', async () => {
    const batch = createTestBatch([301, 302]);
    const git = new FakeGitPort();
    // Huge commit history
    const hugeLogs = Array.from({ length: 2000 }, (_, i) => `commit ${i}: ${'x'.repeat(50)}`);
    git.logBetweenResults.set('sha-main-start|sha-candidate-big', hugeLogs);

    const result = await assemblePromotionPr({
      batch,
      repoFullName,
      candidateSha: 'sha-candidate-big',
      localBasePath: '/tmp/repo',
      git,
    });

    expect(result.body.length).toBeLessThanOrEqual(60_000);
    expect(result.body).toContain('... [Content truncated to meet GitHub character limits]');
    expect(result.body).toContain('Closes #301');
    expect(result.body).toContain('Closes #302');
  });
});

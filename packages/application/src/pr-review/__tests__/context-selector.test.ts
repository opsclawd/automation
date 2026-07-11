import { describe, it, expect, vi } from 'vitest';
import { DefaultContextSelector } from '../context-selector.js';
import { FakeGitPort } from '../../test-doubles/fake-git-port.js';
import { createPrReviewComment, RunId } from '@ai-sdlc/domain';

describe('DefaultContextSelector', () => {
  const runId = RunId('test-run');
  const git = new FakeGitPort();
  const selector = new DefaultContextSelector(git);

  const diff = `diff --git a/a.ts b/a.ts
index 123..456 100644
--- a/a.ts
+++ b/a.ts
@@ -1,5 +1,5 @@
 line 1
-line 2
+line 2 mod
 line 3
 line 4
 line 5
diff --git a/b.ts b/b.ts
index 789..012 100644
--- a/b.ts
+++ b/b.ts
@@ -10,5 +10,5 @@
 line 10
-line 11
+line 11 mod
 line 12
 line 13
 line 14`;

  it('provides tiered context: Tier 1 (Hunks)', async () => {
    vi.spyOn(git, 'diffStat').mockResolvedValue('a.ts | 2 +-\nb.ts | 2 +-\n2 files changed');

    const result = await selector.select({
      cwd: 'test-cwd',
      attempt: 1,
      diff,
      comments: [
        createPrReviewComment({
          runId,
          prNumber: 1,
          commentId: 101,
          path: 'a.ts',
          line: 2,
          reviewer: 'bot',
          body: 'typo',
          now: new Date(),
        })
      ],
      previousBuildError: undefined,
      previousCodeVerifyReason: undefined,
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].path).toBe('a.ts');
    expect(result.diffs[0].content).toContain('line 2 mod');
    expect(result.diffs[0].content).not.toContain('line 11 mod');
  });

  it('provides tiered context: Tier 2 (Full File Diff + Errors)', async () => {
    vi.spyOn(git, 'diffStat').mockResolvedValue('a.ts | 2 +-\nb.ts | 2 +-\n2 files changed');

    const result = await selector.select({
      cwd: 'test-cwd',
      attempt: 2,
      diff,
      comments: [
        createPrReviewComment({
          runId,
          prNumber: 1,
          commentId: 101,
          path: 'a.ts',
          line: 2,
          reviewer: 'bot',
          body: 'typo',
          now: new Date(),
        })
      ],
      previousBuildError: 'Build failed at line 5',
      previousCodeVerifyReason: 'Fix did not address the issue',
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].path).toBe('a.ts');
    expect(result.diffs[0].content).toContain('line 1');
    expect(result.diffs[0].content).toContain('line 5');
    expect(result.additionalInfo).toContain('Build failed at line 5');
    expect(result.additionalInfo).toContain('Fix did not address the issue');
  });

  it('provides tiered context: Tier 3 (Full PR Diff)', async () => {
    vi.spyOn(git, 'diffStat').mockResolvedValue('a.ts | 2 +-\nb.ts | 2 +-\n2 files changed');

    const result = await selector.select({
      cwd: 'test-cwd',
      attempt: 3,
      diff,
      comments: [
        createPrReviewComment({
          runId,
          prNumber: 1,
          commentId: 101,
          path: 'a.ts',
          line: 2,
          reviewer: 'bot',
          body: 'typo',
          now: new Date(),
        })
      ],
      previousBuildError: undefined,
      previousCodeVerifyReason: undefined,
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].content).toBe(diff);
  });
});

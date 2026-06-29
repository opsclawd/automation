import { describe, it, expect } from 'vitest';
import { buildReviewFixReviewPrompt, buildReviewFixFixPrompt } from '../review-fix-prompts.js';
import { type ArchitectPlan } from '@ai-sdlc/application';

describe('review-fix prompts builders', () => {
  describe('buildReviewFixReviewPrompt', () => {
    it('contains ## BUILD/LINT FAILURE and the history block when both are provided', () => {
      const result = buildReviewFixReviewPrompt({
        cwd: '/test/cwd',
        repoId: 'test-repo',
        defaultBranch: 'main',
        gateFailureOutput: 'Typecheck error on line 42',
        historyContext:
          '## Prior Iteration History\n- Iteration 1:\n  Verdict: fail\n  Outcome: unresolved',
      });

      expect(result).toContain('## BUILD/LINT FAILURE');
      expect(result).toContain('Typecheck error on line 42');
      expect(result).toContain('## Prior Iteration History');
      expect(result).toContain('Verdict: fail');
    });

    it('still contains Run: git diff origin/main...HEAD', () => {
      const result = buildReviewFixReviewPrompt({
        cwd: '/test/cwd',
        repoId: 'test-repo',
        defaultBranch: 'main',
      });

      expect(result).toContain('Run: git diff origin/main...HEAD');
    });
  });

  describe('buildReviewFixFixPrompt', () => {
    it('contains Review findings: ./code-review.md, the history block, and ## TASK in that order', () => {
      const historyContext = '## Prior Fix Attempts\n- Iteration 1:\n  Verdict: cannot_fix';
      const result = buildReviewFixFixPrompt({
        cwd: '/test/cwd',
        repoId: 'test-repo',
        historyContext,
        useFallback: false,
      });

      const findingsIndex = result.indexOf('Review findings: ./code-review.md');
      const historyIndex = result.indexOf(historyContext);
      const taskIndex = result.indexOf('## TASK');

      expect(findingsIndex).not.toBe(-1);
      expect(historyIndex).not.toBe(-1);
      expect(taskIndex).not.toBe(-1);

      expect(findingsIndex).toBeLessThan(historyIndex);
      expect(historyIndex).toBeLessThan(taskIndex);
    });

    it('preserves architect plan and fallback note when supplied', () => {
      const architectPlan: ArchitectPlan = {
        version: 1,
        tasks: [
          {
            task_id: 'task-1',
            approach: 'Use helper function',
            conflicts_resolved: [],
            constraints: [],
            depends_on: [],
          },
        ],
      };

      const result = buildReviewFixFixPrompt({
        cwd: '/test/cwd',
        repoId: 'test-repo',
        useFallback: true,
        architectPlan,
      });

      expect(result).toContain('## CROSS-TASK FIX PLAN');
      expect(result).toContain('Use helper function');
      expect(result).toContain('## NOTE');
      expect(result).toContain('The previous fix attempt failed.');
    });
  });
});

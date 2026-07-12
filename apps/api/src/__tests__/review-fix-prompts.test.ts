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
      expect(result).toContain('## WORKSPACE CONSTRAINTS');
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

      // Task 8: verify HEAD-advance commit contract is present
      expect(result).toMatch(/Record HEAD before: `PRE_HEAD=\$\(git rev-parse HEAD\)`/);
      expect(result).toMatch(/COMMIT DID NOT ADVANCE HEAD/);
      expect(result).toMatch(/After fixing, commit your change before writing result\.json/);
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
      expect(result).toContain('## WORKSPACE CONSTRAINTS');
      expect(result).toContain('The previous fix attempt failed.');
    });
  });
});

describe('buildReviewFixReviewPrompt — SCOPE block (#627)', () => {
  const baseInput = {
    cwd: '/wt',
    repoId: 'owner/repo',
    defaultBranch: 'main',
  };

  it('emits the full-feature diff command when prevReviewedCommitSha is omitted', () => {
    const prompt = buildReviewFixReviewPrompt(baseInput);
    expect(prompt).toContain('git diff origin/main...HEAD');
    expect(prompt).not.toContain('## SCOPE');
    expect(prompt).not.toContain('## DISPOSITION GUIDANCE');
  });

  it('emits the SCOPE block and delta diff command when prevReviewedCommitSha is provided', () => {
    const prompt = buildReviewFixReviewPrompt({
      ...baseInput,
      prevReviewedCommitSha: 'abc1234',
    });
    expect(prompt).toContain('## SCOPE');
    expect(prompt).toContain('git diff abc1234..HEAD');
    expect(prompt).not.toContain('git diff origin/main...HEAD');
  });

  it('appends DISPOSITION GUIDANCE whenever prevReviewedCommitSha is set', () => {
    const prompt = buildReviewFixReviewPrompt({
      ...baseInput,
      prevReviewedCommitSha: 'def5678',
    });
    expect(prompt).toContain('## DISPOSITION GUIDANCE');
    expect(prompt).toContain('Addressed findings');
    expect(prompt).toContain('Rebutted findings');
  });

  it('does not emit SCOPE when iterationIndex is effectively 1 (no prevReviewedCommitSha)', () => {
    const prompt = buildReviewFixReviewPrompt({ ...baseInput });
    expect(prompt).not.toContain('## SCOPE');
    expect(prompt).not.toContain('## DISPOSITION GUIDANCE');
  });

  it('renders INTEGRATION MODE and unresolved records / dispositions when mode is integration_full', () => {
    const prompt = buildReviewFixReviewPrompt({
      ...baseInput,
      mode: 'integration_full',
      unresolvedRecords: [
        {
          reviewerKind: 'integration',
          severity: 'critical',
          summary: 'Wiring mismatch',
          fingerprint: 'fp-1',
        },
      ],
      dispositionHistory: [{ fingerprint: 'fp-1', disposition: 'open', changedAt: '2026-07-12' }],
    });

    expect(prompt).toContain('## INTEGRATION MODE');
    expect(prompt).toContain('Review Mode: integration_full');
    expect(prompt).toContain('Wiring mismatch');
    expect(prompt).toContain('fp-1');
  });
});

describe('buildWholePrArbiterPrompt', () => {
  it('renders disputed findings, disposition history, and delta info', async () => {
    const { buildWholePrArbiterPrompt } = await import('../review-fix-prompts.js');
    const prompt = buildWholePrArbiterPrompt({
      cwd: '/wt',
      repoId: 'owner/repo',
      disputedFinding: {
        fingerprint: 'fp-1',
        severity: 'critical',
        summary: 'Wiring mismatch',
      },
      dispositionHistory: [
        {
          fingerprint: 'fp-1',
          disposition: 'open',
          changedAt: '2026-07-12',
          reason: 'Initial failure',
        },
      ],
      relevantExcerpts: ['Line 10: bad wiring'],
      fixDelta: '--- a/file.ts\n+++ b/file.ts',
      fixRebuttal: 'It is correct.',
    });

    expect(prompt).toContain('## DISPUTED INTEGRATION FINDING');
    expect(prompt).toContain('Wiring mismatch');
    expect(prompt).toContain('## DISPOSITION HISTORY');
    expect(prompt).toContain('Initial failure');
    expect(prompt).toContain('## FIXER REBUTTAL');
    expect(prompt).toContain('It is correct.');
    expect(prompt).toContain('## RELEVANT EXCERPTS');
    expect(prompt).toContain('Line 10: bad wiring');
    expect(prompt).toContain('## FIX DELTA');
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSpecReviewPrompt, buildQualityReviewPrompt } from '../compose.js';

const composeSource = readFileSync(new URL('../compose.ts', import.meta.url), 'utf-8');

function sourceSection(pattern: RegExp): string {
  const match = composeSource.match(pattern);
  expect(match).toBeTruthy();
  return match![0];
}

describe('compose review-state wiring', () => {
  describe('buildSpecReviewPrompt with scope', () => {
    it('emits review_mode in metadata context for initial_full', () => {
      const prompt = buildSpecReviewPrompt({
        ctx: { stepIndex: 1, stepTitle: 'Test task', cwd: '/tmp/test' },
        typecheckSection: '## TYPECHECK RESULT\nResult: PASS',
        implReport: '',
        scope: { mode: 'initial_full' },
      });
      expect(prompt).toContain('## REVIEW MODE: INITIAL FULL');
    });

    it('emits review_mode for intermediate_delta with diff command', () => {
      const prompt = buildSpecReviewPrompt({
        ctx: { stepIndex: 2, stepTitle: 'Delta task', cwd: '/tmp/test' },
        typecheckSection: '## TYPECHECK RESULT\nResult: PASS',
        scope: {
          mode: 'intermediate_delta',
          baseIdentity: 'abc123',
          snapshotIdentity: 'def456',
        },
      });
      expect(prompt).toContain('## REVIEW MODE: DELTA (intermediate)');
      expect(prompt).toContain('git diff abc123..def456');
    });

    it('emits review_mode for final_full', () => {
      const prompt = buildSpecReviewPrompt({
        ctx: { stepIndex: 3, stepTitle: 'Final task', cwd: '/tmp/test' },
        typecheckSection: '## TYPECHECK RESULT\nResult: PASS',
        scope: { mode: 'final_full' },
      });
      expect(prompt).toContain('## REVIEW MODE: FINAL FULL');
    });

    it('renders unresolved findings for intermediate_delta', () => {
      const prompt = buildSpecReviewPrompt({
        ctx: { stepIndex: 1, stepTitle: 'Test', cwd: '/tmp/test' },
        typecheckSection: '## TYPECHECK RESULT\nResult: PASS',
        scope: {
          mode: 'intermediate_delta',
          unresolvedFindings: [
            { fingerprint: 'fp1', severity: 'P1', summary: 'Missing error handling' },
          ],
        },
      });
      expect(prompt).toContain('## UNRESOLVED FINDINGS (from prior review)');
      expect(prompt).toContain('Missing error handling');
    });

    it('renders disposition history for intermediate_delta', () => {
      const prompt = buildSpecReviewPrompt({
        ctx: { stepIndex: 1, stepTitle: 'Test', cwd: '/tmp/test' },
        typecheckSection: '## TYPECHECK RESULT\nResult: PASS',
        scope: {
          mode: 'intermediate_delta',
          dispositions: [{ fingerprint: 'fp1', disposition: 'addressed', reason: 'Fixed' }],
        },
      });
      expect(prompt).toContain('## PRIOR DISPOSITIONS');
      expect(prompt).toContain('fp1');
      expect(prompt).toContain('addressed');
    });
  });

  describe('buildQualityReviewPrompt with scope', () => {
    it('emits review_mode for initial_full', () => {
      const prompt = buildQualityReviewPrompt({
        ctx: { stepIndex: 1, stepTitle: 'Test task', cwd: '/tmp/test' },
        typecheckSection: '## TYPECHECK RESULT\nResult: PASS',
        scope: { mode: 'initial_full' },
      });
      expect(prompt).toContain('## REVIEW MODE: INITIAL FULL');
    });

    it('emits review_mode for intermediate_delta with diff command', () => {
      const prompt = buildQualityReviewPrompt({
        ctx: { stepIndex: 2, stepTitle: 'Delta task', cwd: '/tmp/test' },
        typecheckSection: '## TYPECHECK RESULT\nResult: PASS',
        scope: {
          mode: 'intermediate_delta',
          baseIdentity: 'abc123',
          snapshotIdentity: 'def456',
        },
      });
      expect(prompt).toContain('## REVIEW MODE: DELTA (intermediate)');
      expect(prompt).toContain('git diff abc123..def456');
    });

    it('emits review_mode for final_full', () => {
      const prompt = buildQualityReviewPrompt({
        ctx: { stepIndex: 3, stepTitle: 'Final task', cwd: '/tmp/test' },
        typecheckSection: '## TYPECHECK RESULT\nResult: PASS',
        scope: { mode: 'final_full' },
      });
      expect(prompt).toContain('## REVIEW MODE: FINAL FULL');
    });

    it('renders unresolved findings for intermediate_delta', () => {
      const prompt = buildQualityReviewPrompt({
        ctx: { stepIndex: 1, stepTitle: 'Test', cwd: '/tmp/test' },
        typecheckSection: '## TYPECHECK RESULT\nResult: PASS',
        scope: {
          mode: 'intermediate_delta',
          unresolvedFindings: [{ fingerprint: 'fp1', severity: 'P2', summary: 'Memory leak' }],
        },
      });
      expect(prompt).toContain('## UNRESOLVED FINDINGS (from prior review)');
      expect(prompt).toContain('Memory leak');
    });
  });

  describe('wiring invariants', () => {
    it('merges and normalizes V1 and V2 declared files for the current one-based step', () => {
      const helper = sourceSection(
        /function declaredFilesForStep[\s\S]*?(?=export interface BuildSpecReviewPromptOptions)/,
      );

      expect(helper).toContain('manifest.tasks[stepIndex - 1]');
      expect(helper).toMatch(
        /\.\.\.\(task\.expected_files \?\? \[\]\)[\s\S]*\.\.\.\(task\.files \?\? \[\]\)/,
      );
      expect(helper).toContain("file.replace(/\\\\/g, '/')");
    });

    it('threads the same declared file list into spec and quality review prompts', () => {
      const specRunner = sourceSection(/const runSpecReview[\s\S]*?(?=const runQualityReview)/);
      const qualityRunner = sourceSection(/const runQualityReview[\s\S]*?(?=const implRunFix)/);

      for (const runner of [specRunner, qualityRunner]) {
        expect(runner).toContain('declaredFilesForStep(ctx.manifest, ctx.stepIndex)');
        expect(runner).toMatch(/build(?:Spec|Quality)ReviewPrompt\(\{[\s\S]*declaredFiles,/);
      }
    });

    it('uses an empty scope when the current manifest task is missing', () => {
      const helper = sourceSection(
        /function declaredFilesForStep[\s\S]*?(?=export interface BuildSpecReviewPromptOptions)/,
      );

      expect(helper).toContain('if (!task) return []');
    });
  });
});

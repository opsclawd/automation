import { describe, expect, it } from 'vitest';
import {
  buildSpecReviewPrompt,
  buildQualityReviewPrompt,
  declaredFilesForStep,
} from '../compose.js';
import type { TaskManifest } from '@ai-sdlc/application';

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

  describe('declaredFilesForStep', () => {
    const manifest: TaskManifest = {
      version: 1,
      tasks: [
        { n: 1, title: 'Task One', status: 'pending' },
        { n: 2, title: 'Task Two', status: 'pending' },
      ],
    };

    it('returns empty array when task does not exist', () => {
      const result = declaredFilesForStep(manifest, 999);
      expect(result).toEqual([]);
    });

    it('merges expected_files and files with normalization', () => {
      const manifestWithFiles: TaskManifest = {
        version: 1,
        tasks: [
          {
            n: 1,
            title: 'Task One',
            status: 'pending',
            expected_files: ['src/foo.ts', 'src\\bar\\test.ts'],
            files: ['src/baz.ts'],
          },
        ],
      };
      const result = declaredFilesForStep(manifestWithFiles, 1);
      expect(result).toEqual(['src/foo.ts', 'src/bar/test.ts', 'src/baz.ts']);
    });

    it('deduplicates paths when same file appears in both expected_files and files', () => {
      const manifestWithDupes: TaskManifest = {
        version: 1,
        tasks: [
          {
            n: 1,
            title: 'Task One',
            status: 'pending',
            expected_files: ['src/shared.ts', 'src/unique1.ts'],
            files: ['src/shared.ts', 'src/unique2.ts'],
          },
        ],
      };
      const result = declaredFilesForStep(manifestWithDupes, 1);
      expect(result).toEqual(['src/shared.ts', 'src/unique1.ts', 'src/unique2.ts']);
    });

    it('deduplicates when the same file uses backslashes in one array and forward slashes in another', () => {
      const manifestWithMixedSeparators: TaskManifest = {
        version: 1,
        tasks: [
          {
            n: 1,
            title: 'Task One',
            status: 'pending',
            expected_files: ['src/foo.ts'],
            files: ['src\\foo.ts'],
          },
        ],
      };
      const result = declaredFilesForStep(manifestWithMixedSeparators, 1);
      expect(result).toEqual(['src/foo.ts']);
    });

    it('handles missing expected_files and files gracefully', () => {
      const manifestEmpty: TaskManifest = {
        version: 1,
        tasks: [{ n: 1, title: 'Task One', status: 'pending' }],
      };
      const result = declaredFilesForStep(manifestEmpty, 1);
      expect(result).toEqual([]);
    });

    it('uses one-based step index', () => {
      const manifestWithFiles: TaskManifest = {
        version: 1,
        tasks: [
          { n: 1, title: 'Task One', status: 'pending' },
          {
            n: 2,
            title: 'Task Two',
            status: 'pending',
            files: ['step2/file.ts'],
          },
        ],
      };
      const result = declaredFilesForStep(manifestWithFiles, 2);
      expect(result).toEqual(['step2/file.ts']);
    });
  });

  describe('wiring invariants', () => {
    it('threads declaredFiles into spec and quality review prompts with same values', () => {
      const manifest: TaskManifest = {
        version: 1,
        tasks: [
          {
            n: 1,
            title: 'Test Task',
            status: 'pending',
            files: ['src/a.ts', 'src/b.ts'],
          },
        ],
      };
      const declaredFiles = declaredFilesForStep(manifest, 1);

      const specPrompt = buildSpecReviewPrompt({
        ctx: { stepIndex: 1, stepTitle: 'Test Task', cwd: '/tmp/test' },
        typecheckSection: '## TYPECHECK RESULT\nResult: PASS',
        scope: { mode: 'initial_full' },
        declaredFiles,
      });

      const qualityPrompt = buildQualityReviewPrompt({
        ctx: { stepIndex: 1, stepTitle: 'Test Task', cwd: '/tmp/test' },
        typecheckSection: '## TYPECHECK RESULT\nResult: PASS',
        scope: { mode: 'initial_full' },
        declaredFiles,
      });

      expect(specPrompt).toContain('## TASK FILE SCOPE');
      expect(specPrompt).toContain('- src/a.ts');
      expect(specPrompt).toContain('- src/b.ts');

      expect(qualityPrompt).toContain('## TASK FILE SCOPE');
      expect(qualityPrompt).toContain('- src/a.ts');
      expect(qualityPrompt).toContain('- src/b.ts');
    });
  });
});

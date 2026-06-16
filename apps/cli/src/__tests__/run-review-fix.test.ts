import { describe, it, expect } from 'vitest';
import {
  validateRequiredFlags,
  exitCodeForPhaseOutcome,
  serializeEventForJsonl,
} from '../run-review-fix.js';

describe('run-review-fix CLI helpers', () => {
  describe('validateRequiredFlags', () => {
    it('lists all required flags when none provided', () => {
      expect(validateRequiredFlags({})).toEqual(['--cwd', '--run-id', '--repo-id', '--repo-root']);
    });
    it('returns empty when all present', () => {
      expect(
        validateRequiredFlags({
          cwd: '/w',
          'run-id': 'u',
          'repo-id': 'o/r',
          'repo-root': '/r',
        }),
      ).toEqual([]);
    });
    it('returns only the missing ones', () => {
      expect(validateRequiredFlags({ cwd: '/w', 'run-id': 'u' })).toEqual([
        '--repo-id',
        '--repo-root',
      ]);
    });
    it('does not require --phase-id', () => {
      expect(
        validateRequiredFlags({
          cwd: '/w',
          'run-id': 'u',
          'repo-id': 'o/r',
          'repo-root': '/r',
          'phase-id': undefined,
        }),
      ).toEqual([]);
    });
  });

  describe('exitCodeForPhaseOutcome', () => {
    it('returns 0 for passed', () => {
      expect(exitCodeForPhaseOutcome('passed')).toBe(0);
    });
    it('returns 1 for failed', () => {
      expect(exitCodeForPhaseOutcome('failed')).toBe(1);
    });
  });

  describe('serializeEventForJsonl', () => {
    it('produces a valid JSON line with runId replaced by displayId', () => {
      const event = {
        runId: 'uuid-does-not-matter',
        level: 'info' as const,
        type: 'loop.iteration.started',
        message: 'iteration 3/10 started',
        timestamp: '2026-06-16T14:30:00.000Z',
        metadata: {},
      };
      const line = serializeEventForJsonl(event, 'issue-375-20260616-200659881');
      const parsed = JSON.parse(line);
      expect(parsed.runId).toBe('issue-375-20260616-200659881');
      expect(parsed.phase).toBeUndefined();
      expect(parsed.level).toBe('info');
      expect(parsed.type).toBe('loop.iteration.started');
      expect(parsed.message).toBe('iteration 3/10 started');
      expect(parsed.timestamp).toBe('2026-06-16T14:30:00.000Z');
      expect(parsed.metadata).toEqual({});
    });

    it('includes phase when present', () => {
      const event = {
        runId: 'uuid-does-not-matter',
        phase: 'whole-pr-review',
        level: 'warn' as const,
        type: 'review.verdict.overridden',
        message: 'severity gate overrode pass to fail',
        timestamp: '2026-06-16T14:35:00.000Z',
        metadata: {},
      };
      const line = serializeEventForJsonl(event, 'display-1');
      const parsed = JSON.parse(line);
      expect(parsed.phase).toBe('whole-pr-review');
    });

    it('omits phase when absent', () => {
      const event = {
        runId: 'uuid-does-not-matter',
        level: 'info' as const,
        type: 'loop.exhausted',
        message: 'loop exhausted after 10 iterations',
        timestamp: '2026-06-16T14:40:00.000Z',
        metadata: {},
      };
      const line = serializeEventForJsonl(event, 'display-2');
      const parsed = JSON.parse(line);
      expect(parsed.phase).toBeUndefined();
      expect('phase' in parsed).toBe(false);
    });

    it('preserves metadata keys', () => {
      const event = {
        runId: 'uuid-does-not-matter',
        level: 'info' as const,
        type: 'loop.iteration.completed',
        message: 'iteration done',
        timestamp: '2026-06-16T14:45:00.000Z',
        metadata: { iteration: 3, findings: 2 },
      };
      const line = serializeEventForJsonl(event, 'display-3');
      const parsed = JSON.parse(line);
      expect(parsed.metadata).toEqual({ iteration: 3, findings: 2 });
    });

    it('defaults metadata to {} when undefined', () => {
      const event = {
        runId: 'uuid-does-not-matter',
        level: 'error' as const,
        type: 'phase.fallback.escalated',
        message: 'escalated to fallback profile',
        timestamp: '2026-06-16T14:50:00.000Z',
      };
      const line = serializeEventForJsonl(
        event as Parameters<typeof serializeEventForJsonl>[0],
        'display-4',
      );
      const parsed = JSON.parse(line);
      expect(parsed.metadata).toEqual({});
    });
  });
});

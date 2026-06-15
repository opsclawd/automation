import { describe, it, expect } from 'vitest';
import { validateRequiredFlags, exitCodeForPhaseOutcome } from '../run-review-fix.js';

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
});

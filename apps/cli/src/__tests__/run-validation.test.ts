import { describe, it, expect } from 'vitest';
import { validateRequiredFlags, exitCodeForValidation } from '../run-validation.js';

describe('run-validation CLI helpers', () => {
  describe('validateRequiredFlags', () => {
    it('lists all required flags when none provided', () => {
      expect(validateRequiredFlags({})).toEqual(['--cwd', '--run-id', '--repo-root']);
    });
    it('returns empty when all present', () => {
      expect(validateRequiredFlags({ cwd: '/w', 'run-id': 'u', 'repo-root': '/r' })).toEqual([]);
    });
    it('returns only the missing ones', () => {
      expect(validateRequiredFlags({ cwd: '/w' })).toEqual(['--run-id', '--repo-root']);
    });
    it('does not require --repo-id, --phase-id, or --target-repo-root', () => {
      expect(
        validateRequiredFlags({
          cwd: '/w',
          'run-id': 'u',
          'repo-root': '/r',
          'repo-id': undefined,
          'target-repo-root': '/target',
        }),
      ).toEqual([]);
    });
  });

  describe('exitCodeForValidation', () => {
    it('returns 0 when passed', () => {
      expect(exitCodeForValidation(true)).toBe(0);
    });
    it('returns 1 when failed', () => {
      expect(exitCodeForValidation(false)).toBe(1);
    });
  });
});

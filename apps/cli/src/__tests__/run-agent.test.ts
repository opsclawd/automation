import { describe, it, expect } from 'vitest';
import {
  validateRequiredFlags,
  exitCodeForOutcome,
  resolveProfileName,
  type ConfigForProfileResolution,
} from '../run-agent.js';

describe('run-agent CLI logic', () => {
  describe('validateRequiredFlags', () => {
    const requiredFlags = [
      '--cwd',
      '--run-id',
      '--repo-id',
      '--phase-id',
      '--prompt-file',
      '--start-sha',
    ];

    it('returns all six flag names when no values provided', () => {
      const missing = validateRequiredFlags({});
      expect(missing).toEqual(requiredFlags);
    });

    it('returns empty array when all required flags present', () => {
      const missing = validateRequiredFlags({
        cwd: '/tmp',
        'run-id': 'abc-123',
        'repo-id': 'owner/repo',
        'phase-id': 'plan-design',
        'prompt-file': '/tmp/prompt.md',
        'start-sha': '0'.repeat(40),
      });
      expect(missing).toEqual([]);
    });

    it('returns only missing flags', () => {
      const missing = validateRequiredFlags({
        cwd: '/tmp',
        'run-id': 'abc-123',
        'repo-id': 'owner/repo',
        'phase-id': 'plan-design',
      });
      expect(missing).toEqual(['--prompt-file', '--start-sha']);
    });
  });

  describe('exitCodeForOutcome', () => {
    it('returns 0 for success', () => {
      expect(exitCodeForOutcome('success')).toBe(0);
    });

    it('returns 2 for timeout', () => {
      expect(exitCodeForOutcome('timeout')).toBe(2);
    });

    it('returns 1 for contract_violation', () => {
      expect(exitCodeForOutcome('contract_violation')).toBe(1);
    });

    it('returns 2 for failed (caller-aborted/timeout)', () => {
      expect(exitCodeForOutcome('failed')).toBe(2);
    });

    it('returns 3 for arbitrary unknown outcome', () => {
      expect(exitCodeForOutcome('nonexistent-outcome')).toBe(3);
    });
  });

  describe('resolveProfileName', () => {
    const config: ConfigForProfileResolution = {
      profiles: {
        'opencode-frontier': {
          runtime: 'opencode',
          provider: 'anthropic',
          model: 'claude-opus-4.7',
          timeoutMinutes: 60,
        },
        'pi-qwen-local': {
          runtime: 'pi',
          provider: 'local',
          model: 'qwen3.6-27b',
          timeoutMinutes: 30,
        },
      },
      phaseProfiles: {
        'plan-design': { profile: 'opencode-frontier' },
        'plan-write': { profile: 'opencode-frontier' },
        review: { profile: 'opencode-frontier' },
        'fix-review': { profile: 'opencode-frontier' },
        'pr-review-poll': { profile: 'opencode-frontier' },
      },
    };

    it('resolves a known phase to its profile', () => {
      const result = resolveProfileName(config, { phase: 'plan-design' });
      expect(result).toEqual({ ok: true, profileName: 'opencode-frontier' });
    });

    it('returns error for an unknown phase', () => {
      const result = resolveProfileName(config, { phase: 'nonexistent-phase' });
      expect(result).toEqual({
        ok: false,
        error: 'unknown phase: nonexistent-phase (no entry in agent.phaseProfiles)',
      });
    });

    it('resolves a known --profile directly', () => {
      const result = resolveProfileName(config, { profile: 'pi-qwen-local' });
      expect(result).toEqual({ ok: true, profileName: 'pi-qwen-local' });
    });

    it('returns error for an unknown --profile', () => {
      const result = resolveProfileName(config, { profile: 'unknown-profile' });
      expect(result).toEqual({ ok: false, error: 'unknown profile: unknown-profile' });
    });

    it('returns error when neither --phase nor --profile is provided', () => {
      const result = resolveProfileName(config, {});
      expect(result).toEqual({ ok: false, error: 'must pass --phase or --profile' });
    });
  });
});

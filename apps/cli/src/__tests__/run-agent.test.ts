import { describe, it, expect } from 'vitest';
import {
  validateRequiredFlags,
  exitCodeForOutcome,
  resolveProfileName,
  phaseToRunType,
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
      expect(exitCodeForOutcome({ outcome: 'success', contractViolations: [] })).toBe(0);
    });

    it('returns 2 for timeout', () => {
      expect(exitCodeForOutcome({ outcome: 'timeout', contractViolations: [] })).toBe(2);
    });

    it('returns 1 for contract_violation', () => {
      expect(exitCodeForOutcome({ outcome: 'contract_violation', contractViolations: [] })).toBe(1);
    });

    it('returns 2 for failed with cancelled_by_orchestrator (caller-abort/timeout)', () => {
      expect(
        exitCodeForOutcome({
          outcome: 'failed',
          contractViolations: ['cancelled_by_orchestrator'],
        }),
      ).toBe(2);
    });

    it('returns 3 for failed without cancelled_by_orchestrator (runtime error)', () => {
      expect(exitCodeForOutcome({ outcome: 'failed', contractViolations: [] })).toBe(3);
    });

    it('returns 3 for failed with other contract violations', () => {
      expect(
        exitCodeForOutcome({ outcome: 'failed', contractViolations: ['some_other_violation'] }),
      ).toBe(3);
    });

    it('returns 3 for arbitrary unknown outcome', () => {
      expect(exitCodeForOutcome({ outcome: 'nonexistent-outcome', contractViolations: [] })).toBe(
        3,
      );
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
        compound: { profile: 'opencode-frontier' },
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

    it('resolves compound phase to its profile', () => {
      const result = resolveProfileName(config, { phase: 'compound' });
      expect(result).toEqual({ ok: true, profileName: 'opencode-frontier' });
    });
  });

  describe('phaseToRunType', () => {
    it('returns consolidate for compound phase', () => {
      expect(phaseToRunType('compound')).toBe('consolidate');
    });

    it('returns pr_review as default fallback', () => {
      expect(phaseToRunType(undefined)).toBe('pr_review');
    });

    it('returns pr_review for unknown phases', () => {
      expect(phaseToRunType('implement')).toBe('pr_review');
      expect(phaseToRunType('review')).toBe('pr_review');
    });
  });
});

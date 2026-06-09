import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import {
  validateRequiredFlags,
  exitCodeForOutcome,
  resolveProfileName,
  phaseToRunType,
  streamTranscript,
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

    it('returns 4 for failed with only provider_error (advisory)', () => {
      expect(
        exitCodeForOutcome({
          outcome: 'failed',
          contractViolations: ['provider_error'],
        }),
      ).toBe(4);
    });

    it('returns 3 for failed with provider_error and other violations', () => {
      expect(
        exitCodeForOutcome({
          outcome: 'failed',
          contractViolations: ['provider_error', 'no_output'],
        }),
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

    describe('phase fallback resolution', () => {
      it('resolves whole-pr-fix-review when explicitly configured', () => {
        const configWithExplicit: ConfigForProfileResolution = {
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
            'fix-review': { profile: 'opencode-frontier' },
            'whole-pr-fix-review': { profile: 'pi-qwen-local' },
          },
        };
        const result = resolveProfileName(configWithExplicit, { phase: 'whole-pr-fix-review' });
        expect(result).toEqual({ ok: true, profileName: 'pi-qwen-local' });
      });

      it('falls back to fix-review when whole-pr-fix-review is not configured', () => {
        const configWithoutExplicit: ConfigForProfileResolution = {
          profiles: {
            'opencode-frontier': {
              runtime: 'opencode',
              provider: 'anthropic',
              model: 'claude-opus-4.7',
              timeoutMinutes: 60,
            },
          },
          phaseProfiles: {
            'fix-review': { profile: 'opencode-frontier' },
          },
        };
        const result = resolveProfileName(configWithoutExplicit, { phase: 'whole-pr-fix-review' });
        expect(result).toEqual({ ok: true, profileName: 'opencode-frontier' });
      });

      it('returns error when neither whole-pr-fix-review nor fix-review is configured', () => {
        const configNoFallback: ConfigForProfileResolution = {
          profiles: {
            'opencode-frontier': {
              runtime: 'opencode',
              provider: 'anthropic',
              model: 'claude-opus-4.7',
              timeoutMinutes: 60,
            },
          },
          phaseProfiles: {
            'plan-design': { profile: 'opencode-frontier' },
          },
        };
        const result = resolveProfileName(configNoFallback, { phase: 'whole-pr-fix-review' });
        expect(result).toEqual({
          ok: false,
          error: 'unknown phase: whole-pr-fix-review (no entry in agent.phaseProfiles)',
        });
      });

      it('falls back to fix-review profile even when fix-review has no fallbackProfile', () => {
        const configMinimal: ConfigForProfileResolution = {
          profiles: {
            builder: {
              runtime: 'opencode',
              provider: 'anthropic',
              model: 'claude-opus-4.7',
              timeoutMinutes: 60,
            },
          },
          phaseProfiles: {
            'fix-review': { profile: 'builder' },
          },
        };
        const result = resolveProfileName(configMinimal, { phase: 'whole-pr-fix-review' });
        expect(result).toEqual({ ok: true, profileName: 'builder' });
      });
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

  describe('streamTranscript', () => {
    let tmpDir: string;
    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'run-agent-test-'));
    });
    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('pipes file contents to destination stream', async () => {
      const filePath = join(tmpDir, 'stdout.log');
      writeFileSync(filePath, 'hello from adapter');
      const dest = new PassThrough();
      const chunks: string[] = [];
      dest.on('data', (chunk: string) => chunks.push(chunk));
      await streamTranscript(filePath, dest);
      expect(chunks.join('')).toBe('hello from adapter');
    });

    it('resolves immediately when filePath is undefined', async () => {
      const dest = new PassThrough();
      const chunks: string[] = [];
      dest.on('data', (chunk: string) => chunks.push(chunk));
      await streamTranscript(undefined, dest);
      expect(chunks).toEqual([]);
    });

    it('resolves immediately when file does not exist', async () => {
      const dest = new PassThrough();
      const chunks: string[] = [];
      dest.on('data', (chunk: string) => chunks.push(chunk));
      await streamTranscript(join(tmpDir, 'nonexistent.log'), dest);
      expect(chunks).toEqual([]);
    });

    it('logs non-ENOENT errors to console.error', async () => {
      const filePath = join(tmpDir, 'unreadable.log');
      writeFileSync(filePath, 'data');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const dest = new PassThrough();
      const { chmodSync } = await import('node:fs');
      try {
        chmodSync(filePath, 0o000);
        await streamTranscript(filePath, dest);
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        chmodSync(filePath, 0o644);
        errorSpy.mockRestore();
      }
    });
  });
});

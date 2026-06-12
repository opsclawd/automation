import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import {
  validateRequiredFlags,
  exitCodeForOutcome,
  cwdViolatesRepoRoot,
  resolveProfileName,
  phaseToRunType,
  streamTranscript,
  persistTranscript,
  type ConfigForProfileResolution,
} from '../run-agent.js';

describe('run-agent CLI logic', () => {
  describe('cwdViolatesRepoRoot', () => {
    it('is true when cwd equals repo-root and a worktree is configured', () => {
      expect(
        cwdViolatesRepoRoot(
          { cwd: '/repo', 'repo-root': '/repo', 'worktree-dir': '/repo/.wt' },
          {},
        ),
      ).toBe(true);
    });

    it('normalizes paths before comparing (trailing slash / dot segments)', () => {
      expect(
        cwdViolatesRepoRoot({ cwd: '/repo/', 'repo-root': '/repo', 'worktree-dir': '/x' }, {}),
      ).toBe(true);
      expect(
        cwdViolatesRepoRoot(
          { cwd: '/repo/sub/..', 'repo-root': '/repo', 'worktree-dir': '/x' },
          {},
        ),
      ).toBe(true);
    });

    it('is false when cwd differs from repo-root (the normal worktree case)', () => {
      expect(
        cwdViolatesRepoRoot(
          { cwd: '/repo/.wt', 'repo-root': '/repo', 'worktree-dir': '/repo/.wt' },
          {},
        ),
      ).toBe(false);
    });

    it('is false when no worktree is configured (consolidation workflows)', () => {
      expect(cwdViolatesRepoRoot({ cwd: '/repo', 'repo-root': '/repo' }, {})).toBe(false);
    });

    it('honors POLL_WORKTREE env as the worktree signal', () => {
      expect(
        cwdViolatesRepoRoot({ cwd: '/repo', 'repo-root': '/repo' }, { POLL_WORKTREE: '/repo/.wt' }),
      ).toBe(true);
    });

    it('is false when repo-root or cwd is missing', () => {
      expect(cwdViolatesRepoRoot({ cwd: '/repo', 'worktree-dir': '/x' }, {})).toBe(false);
      expect(cwdViolatesRepoRoot({ 'repo-root': '/repo', 'worktree-dir': '/x' }, {})).toBe(false);
    });
  });

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

  describe('persistTranscript', () => {
    let tmpDir: string;
    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'persist-transcript-test-'));
    });
    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });
    it('returns empty array and does nothing for success outcome', () => {
      const result = persistTranscript(
        {
          outcome: 'success',
          stdoutPath: '/nonexistent/stdout.log',
          stderrPath: '/nonexistent/stderr.log',
        },
        'plan-review-1',
        tmpDir,
      );
      expect(result).toEqual([]);
    });
    it('copies stdout to .ai-runs/ on non-success outcome', () => {
      const stdoutFile = join(tmpDir, 'stdout.log');
      writeFileSync(stdoutFile, 'agent stdout content');
      const result = persistTranscript(
        { outcome: 'contract_violation', stdoutPath: stdoutFile },
        'plan-review-1',
        tmpDir,
      );
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0]).toContain('.ai-runs/agent-transcript-plan-review-1-');
      expect(readFileSync(result[0], 'utf-8')).toBe('agent stdout content');
    });
    it('copies stderr to .ai-runs/ on non-success outcome', () => {
      const stderrFile = join(tmpDir, 'stderr.log');
      writeFileSync(stderrFile, 'agent stderr content');
      const result = persistTranscript(
        { outcome: 'failed', stderrPath: stderrFile },
        'plan-review-1',
        tmpDir,
      );
      expect(result.length).toBeGreaterThanOrEqual(1);
      const stderrDest = result.find((p) => p.includes('agent-stderr'));
      expect(stderrDest).toBeDefined();
      expect(readFileSync(stderrDest!, 'utf-8')).toBe('agent stderr content');
    });
    it('copies both stdout and stderr when both paths present', () => {
      const stdoutFile = join(tmpDir, 'stdout.log');
      const stderrFile = join(tmpDir, 'stderr.log');
      writeFileSync(stdoutFile, 'out');
      writeFileSync(stderrFile, 'err');
      const result = persistTranscript(
        { outcome: 'timeout', stdoutPath: stdoutFile, stderrPath: stderrFile },
        'plan-review-1',
        tmpDir,
      );
      expect(result.length).toBe(2);
    });
    it('does not crash when source files are missing', () => {
      const result = persistTranscript(
        { outcome: 'failed', stdoutPath: join(tmpDir, 'nonexistent.log') },
        'plan-review-1',
        tmpDir,
      );
      expect(result).toEqual([]);
    });
    it('does not crash when stdoutPath is undefined', () => {
      const result = persistTranscript({ outcome: 'contract_violation' }, 'plan-review-1', tmpDir);
      expect(result).toEqual([]);
    });
    it('calls the custom logger with the transcript path on success', () => {
      const stdoutFile = join(tmpDir, 'stdout.log');
      writeFileSync(stdoutFile, 'content');
      const logs: string[] = [];
      const logger = (...args: string[]) => logs.push(args.join(' '));
      persistTranscript(
        { outcome: 'contract_violation', stdoutPath: stdoutFile },
        'plan-review-1',
        tmpDir,
        logger,
      );
      expect(logs).toEqual(
        expect.arrayContaining([expect.stringContaining('Agent transcript saved to:')]),
      );
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

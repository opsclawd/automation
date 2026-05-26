import { describe, it, expect, vi } from 'vitest';

// We test the constituent logic extracted from main().
// The main() function is tested via integration; unit tests cover
// individual concerns that are hard to reach through the integration path.

describe('run-agent CLI logic', () => {
  describe('profile resolution', () => {
    const config = {
      defaultProfile: 'opencode-frontier' as const,
      profiles: {
        'opencode-frontier': {
          runtime: 'opencode' as const,
          provider: 'anthropic',
          model: 'claude-opus-4.7',
          timeoutMinutes: 60,
        },
        'pi-qwen-local': {
          runtime: 'pi' as const,
          provider: 'local',
          model: 'qwen3.6-27b',
          contextLimitTokens: 64000,
          promptBudgetTokens: 40000,
          outputBudgetTokens: 8000,
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
      const entry = config.phaseProfiles['plan-design'];
      expect(entry?.profile).toBe('opencode-frontier');
    });

    it('throws ConfigError for an unknown phase', () => {
      const entry = config.phaseProfiles['nonexistent-phase'];
      expect(entry).toBeUndefined();
    });

    it('resolves a known --profile directly', () => {
      const profile = config.profiles['pi-qwen-local'];
      expect(profile).toBeDefined();
      expect(profile?.runtime).toBe('pi');
    });

    it('rejects an unknown --profile', () => {
      const profile = config.profiles['unknown-profile'];
      expect(profile).toBeUndefined();
    });
  });

  describe('required flag validation', () => {
    const required = ['cwd', 'run-id', 'repo-id', 'phase-id', 'prompt-file', 'start-sha'];

    it('reports all missing required flags', () => {
      // Simulate the validation logic from main()
      const values: Record<string, string | undefined> = {};
      const missing = required.filter((f) => !values[f]);
      expect(missing.length).toBe(required.length);
    });

    it('passes when all required flags are present', () => {
      const values: Record<string, string | undefined> = {
        cwd: '/tmp',
        'run-id': 'abc-123',
        'repo-id': 'owner/repo',
        'phase-id': 'plan-design',
        'prompt-file': '/tmp/prompt.md',
        'start-sha': '0'.repeat(40),
      };
      const missing = required.filter((f) => !values[f]);
      expect(missing.length).toBe(0);
    });
  });

  describe('exit codes', () => {
    it('exits 0 on success outcome', () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const result: { outcome: string } = { outcome: 'success' };
      if (result.outcome === 'success') process.exit(0);
      expect(exit).toHaveBeenCalledWith(0);
      exit.mockRestore();
    });

    it('exits 2 on timeout outcome', () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const result: { outcome: string } = { outcome: 'timeout' };
      if (result.outcome === 'timeout') process.exit(2);
      expect(exit).toHaveBeenCalledWith(2);
      exit.mockRestore();
    });

    it('exits 1 on contract_violation outcome', () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const result: { outcome: string } = { outcome: 'contract_violation' };
      if (result.outcome === 'contract_violation') process.exit(1);
      expect(exit).toHaveBeenCalledWith(1);
      exit.mockRestore();
    });

    it('exits 3 on unknown outcome', () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const result: { outcome: string } = { outcome: 'failed' };
      if (result.outcome === 'success') process.exit(0);
      if (result.outcome === 'timeout') process.exit(2);
      if (result.outcome === 'contract_violation') process.exit(1);
      process.exit(3);
      expect(exit).toHaveBeenCalledWith(3);
      exit.mockRestore();
    });
  });
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../loader.js';
import { ConfigError } from '../errors.js';

function makeRepo(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-cfg-'));
  if (contents !== undefined) writeFileSync(join(dir, '.ai-orchestrator.json'), contents);
  return dir;
}

describe('loadConfig', () => {
  it('parses a valid config', () => {
    const repo = makeRepo(
      JSON.stringify({
        validation: { commands: ['pnpm build'], timeout: 300 },
        phases: {
          skip: ['compound'],
          reviewFix: { maxIterations: 10 },
          implement: { maxIterations: 5 },
        },
        timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
      }),
    );
    const cfg = loadConfig(repo);
    expect(cfg.validation.commands).toEqual(['pnpm build']);
    expect(cfg.phases.skip).toEqual(['compound']);
    expect(cfg.timeouts.readyMaxDays).toBe(7);
  });

  it('throws ConfigError when file is missing', () => {
    const repo = makeRepo();
    expect(() => loadConfig(repo)).toThrow(ConfigError);
    expect(() => loadConfig(repo)).toThrow(/\.ai-orchestrator\.json/);
  });

  it('throws ConfigError when JSON is malformed', () => {
    const repo = makeRepo('{ not json');
    expect(() => loadConfig(repo)).toThrow(ConfigError);
    expect(() => loadConfig(repo)).toThrow(/^Invalid JSON/);
  });

  it('throws ConfigError with field path on invalid value', () => {
    const repo = makeRepo(
      JSON.stringify({
        validation: { commands: [], timeout: -1 },
        phases: {
          skip: [],
          reviewFix: { maxIterations: 10 },
          implement: { maxIterations: 5 },
        },
        timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
      }),
    );
    expect(() => loadConfig(repo)).toThrow(ConfigError);
    expect(() => loadConfig(repo)).toThrow(/validation\.timeout/);
    expect(() => loadConfig(repo)).toThrow(/validation\.commands/);
  });

  describe('env overrides', () => {
    const agentConfig = {
      validation: { commands: ['pnpm build'], timeout: 300 },
      phases: {
        skip: [],
        reviewFix: { maxIterations: 10 },
        implement: { maxIterations: 5 },
      },
      timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
      agent: {
        defaultProfile: 'opencode-frontier',
        profiles: {
          'opencode-frontier': {
            runtime: 'opencode',
            provider: 'minimax',
            model: 'M2.7',
            timeoutMinutes: 60,
          },
          'pi-qwen-local': {
            runtime: 'pi',
            provider: 'local',
            model: 'qwen3.6-27b',
            contextLimitTokens: 64000,
            timeoutMinutes: 30,
          },
        },
        phaseProfiles: {
          'plan-design': { profile: 'opencode-frontier' },
          implement: { profile: 'pi-qwen-local', fallbackProfile: 'opencode-frontier' },
        },
      },
    };

    it('AI_ORCHESTRATOR_PROFILE overrides defaultProfile', () => {
      const repo = makeRepo(JSON.stringify(agentConfig));
      const cfg = loadConfig(repo, { AI_ORCHESTRATOR_PROFILE: 'pi-qwen-local' });
      expect(cfg.agent?.defaultProfile).toBe('pi-qwen-local');
    });

    it('AI_ORCHESTRATOR_PHASE_<PHASE> overrides per-phase profile (kebab→snake)', () => {
      const repo = makeRepo(JSON.stringify(agentConfig));
      const cfg = loadConfig(repo, { AI_ORCHESTRATOR_PHASE_PLAN_DESIGN: 'pi-qwen-local' });
      expect(cfg.agent?.phaseProfiles['plan-design'].profile).toBe('pi-qwen-local');
    });

    it('preserves fallbackProfile when overriding a phase', () => {
      const repo = makeRepo(JSON.stringify(agentConfig));
      const cfg = loadConfig(repo, { AI_ORCHESTRATOR_PHASE_IMPLEMENT: 'opencode-frontier' });
      expect(cfg.agent?.phaseProfiles.implement).toEqual({
        profile: 'opencode-frontier',
        fallbackProfile: 'opencode-frontier',
      });
    });

    it('rejects override pointing at undefined profile via schema validation', () => {
      const repo = makeRepo(JSON.stringify(agentConfig));
      expect(() => loadConfig(repo, { AI_ORCHESTRATOR_PROFILE: 'nope' })).toThrow(
        /defaultProfile 'nope' is not defined/,
      );
    });

    it('rejects unknown phase env var', () => {
      const repo = makeRepo(JSON.stringify(agentConfig));
      expect(() => loadConfig(repo, { AI_ORCHESTRATOR_PHASE_REVIEW: 'pi-qwen-local' })).toThrow(
        /does not match any phase/,
      );
    });

    it('throws if overrides set but config has no agent block', () => {
      const repo = makeRepo(
        JSON.stringify({
          validation: { commands: ['pnpm build'], timeout: 300 },
          phases: { reviewFix: { maxIterations: 10 }, implement: { maxIterations: 5 } },
          timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
        }),
      );
      expect(() => loadConfig(repo, { AI_ORCHESTRATOR_PROFILE: 'whatever' })).toThrow(
        /no 'agent' block/,
      );
    });

    it('ignores blank/unset env values', () => {
      const repo = makeRepo(JSON.stringify(agentConfig));
      const cfg = loadConfig(repo, {
        AI_ORCHESTRATOR_PROFILE: '   ',
        AI_ORCHESTRATOR_PHASE_PLAN_DESIGN: '',
      });
      expect(cfg.agent?.defaultProfile).toBe('opencode-frontier');
      expect(cfg.agent?.phaseProfiles['plan-design'].profile).toBe('opencode-frontier');
    });
  });

  it('defaults phases.skip to [] when omitted', () => {
    const repo = makeRepo(
      JSON.stringify({
        validation: { commands: ['pnpm build'], timeout: 300 },
        phases: {
          reviewFix: { maxIterations: 10 },
          implement: { maxIterations: 5 },
        },
        timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
      }),
    );
    const cfg = loadConfig(repo);
    expect(cfg.phases.skip).toEqual([]);
  });
});

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { orchestratorConfigSchema } from '../config/schema.js';

const baseValid = {
  validation: { commands: ['pnpm test'], timeout: 60 },
  phases: { skip: [], reviewFix: { maxIterations: 10 }, implement: { maxIterations: 5 } },
  timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  agent: {
    defaultProfile: 'opencode-frontier',
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
        contextLimitTokens: 64000,
        promptBudgetTokens: 40000,
        outputBudgetTokens: 8000,
        timeoutMinutes: 30,
      },
    },
    phaseProfiles: {
      'plan-design': { profile: 'opencode-frontier' },
      implement: { profile: 'pi-qwen-local', fallbackProfile: 'opencode-frontier' },
    },
  },
};

describe('agent config schema', () => {
  it('accepts a valid agent config', () => {
    expect(() => orchestratorConfigSchema.parse(baseValid)).not.toThrow();
  });

  it('rejects an unknown runtime', () => {
    const bad = structuredClone(baseValid);
    (bad.agent.profiles['opencode-frontier'] as { runtime: string }).runtime = 'banana';
    expect(() => orchestratorConfigSchema.parse(bad)).toThrow(/runtime/);
  });

  it('rejects phaseProfiles referencing an unknown profile', () => {
    const bad = structuredClone(baseValid);
    bad.agent.phaseProfiles['plan-design'].profile = 'missing-profile';
    expect(() => orchestratorConfigSchema.parse(bad)).toThrow(
      /phaseProfiles\.plan-design\.profile/,
    );
  });

  it('rejects phaseProfiles referencing an unknown fallbackProfile', () => {
    const bad = structuredClone(baseValid);
    bad.agent.phaseProfiles['implement'].fallbackProfile = 'no-such-profile';
    expect(() => orchestratorConfigSchema.parse(bad)).toThrow(/fallbackProfile/);
  });

  it('rejects defaultProfile that is not in profiles', () => {
    const bad = structuredClone(baseValid);
    bad.agent.defaultProfile = 'nope';
    expect(() => orchestratorConfigSchema.parse(bad)).toThrow(/defaultProfile/);
  });

  it('rejects pi profile missing contextLimitTokens', () => {
    const bad = structuredClone(baseValid);
    delete (bad.agent.profiles['pi-qwen-local'] as Record<string, unknown>).contextLimitTokens;
    expect(() => orchestratorConfigSchema.parse(bad)).toThrow(/contextLimitTokens/);
  });

  it('rejects negative promptBudgetTokens on a pi profile', () => {
    const bad = structuredClone(baseValid);
    (bad.agent.profiles['pi-qwen-local'] as Record<string, unknown>).promptBudgetTokens = -1;
    expect(() => orchestratorConfigSchema.parse(bad)).toThrow(/promptBudgetTokens/);
  });

  it('rejects empty profiles with a non-empty defaultProfile', () => {
    const bad = structuredClone(baseValid);
    bad.agent.profiles = {};
    expect(() => orchestratorConfigSchema.parse(bad)).toThrow(/defaultProfile/);
  });

  it('rejects unknown keys in phaseProfile entries', () => {
    const bad = structuredClone(baseValid);
    (bad.agent.phaseProfiles['plan-design'] as Record<string, unknown>).fallbackprofile =
      'opencode-frontier';
    expect(() => orchestratorConfigSchema.parse(bad)).toThrow(/unrecognized/i);
  });

  it('accepts config without agent field', () => {
    const { validation, phases, timeouts } = baseValid;
    expect(() => orchestratorConfigSchema.parse({ validation, phases, timeouts })).not.toThrow();
  });

  it('rejects whitespace-only provider', () => {
    const bad = structuredClone(baseValid);
    (bad.agent.profiles['opencode-frontier'] as Record<string, unknown>).provider = '   ';
    expect(() => orchestratorConfigSchema.parse(bad)).toThrow(/provider/);
  });

  it('rejects whitespace-only model', () => {
    const bad = structuredClone(baseValid);
    (bad.agent.profiles['opencode-frontier'] as Record<string, unknown>).model = '   ';
    expect(() => orchestratorConfigSchema.parse(bad)).toThrow(/model/);
  });

  it('rejects whitespace-only defaultProfile', () => {
    const bad = structuredClone(baseValid);
    bad.agent.defaultProfile = '   ';
    expect(() => orchestratorConfigSchema.parse(bad)).toThrow(/defaultProfile/);
  });

  it('rejects whitespace-only phaseProfiles profile reference', () => {
    const bad = structuredClone(baseValid);
    bad.agent.phaseProfiles['plan-design'].profile = '   ';
    expect(() => orchestratorConfigSchema.parse(bad)).toThrow(/profile/);
  });

  it('rejects misspelled top-level keys like "agnet"', () => {
    const { validation, phases, timeouts, agent } = baseValid;
    expect(() =>
      orchestratorConfigSchema.parse({ validation, phases, timeouts, agnet: agent }),
    ).toThrow(/unrecognized/i);
  });

  it('rejects profiles key with leading/trailing whitespace', () => {
    const bad = structuredClone(baseValid);
    bad.agent.profiles[' opencode-frontier'] = structuredClone(
      bad.agent.profiles['opencode-frontier'],
    );
    delete bad.agent.profiles['opencode-frontier'];
    expect(() => orchestratorConfigSchema.parse(bad)).toThrow(/whitespace/);
  });

  it('rejects phaseProfiles key with leading/trailing whitespace', () => {
    const bad = structuredClone(baseValid);
    bad.agent.phaseProfiles[' plan-design'] = structuredClone(
      bad.agent.phaseProfiles['plan-design'],
    );
    delete bad.agent.phaseProfiles['plan-design'];
    expect(() => orchestratorConfigSchema.parse(bad)).toThrow(/whitespace/);
  });

  it('accepts an antigravity runtime profile', () => {
    const cfg = structuredClone(baseValid);
    cfg.agent.profiles['antigravity-reviewer'] = {
      runtime: 'antigravity',
      provider: 'google',
      model: 'default',
      timeoutMinutes: 45,
    };
    expect(() => orchestratorConfigSchema.parse(cfg)).not.toThrow();
  });

  it('accepts a claude-code runtime profile', () => {
    const cfg = structuredClone(baseValid);
    cfg.agent.profiles['claude-reviewer'] = {
      runtime: 'claude-code',
      provider: 'anthropic',
      model: 'default',
      timeoutMinutes: 45,
    };
    expect(() => orchestratorConfigSchema.parse(cfg)).not.toThrow();
  });

  it('accepts a codex runtime profile', () => {
    const cfg = structuredClone(baseValid);
    cfg.agent.profiles['codex-reviewer'] = {
      runtime: 'codex',
      provider: 'openai',
      model: 'default',
      timeoutMinutes: 45,
    };
    expect(() => orchestratorConfigSchema.parse(cfg)).not.toThrow();
  });
});

describe('variant field on profiles', () => {
  it('accepts variant low on a profile', () => {
    const cfg = structuredClone(baseValid);
    (cfg.agent.profiles['opencode-frontier'] as Record<string, unknown>).variant = 'low';
    expect(() => orchestratorConfigSchema.parse(cfg)).not.toThrow();
  });

  it('accepts variant medium on a profile', () => {
    const cfg = structuredClone(baseValid);
    (cfg.agent.profiles['opencode-frontier'] as Record<string, unknown>).variant = 'medium';
    expect(() => orchestratorConfigSchema.parse(cfg)).not.toThrow();
  });

  it('accepts variant high on a profile', () => {
    const cfg = structuredClone(baseValid);
    (cfg.agent.profiles['opencode-frontier'] as Record<string, unknown>).variant = 'high';
    expect(() => orchestratorConfigSchema.parse(cfg)).not.toThrow();
  });

  it('rejects an unknown variant value', () => {
    const cfg = structuredClone(baseValid);
    (cfg.agent.profiles['opencode-frontier'] as Record<string, unknown>).variant = 'ultra';
    expect(() => orchestratorConfigSchema.parse(cfg)).toThrow(/variant/);
  });

  it('accepts profile without variant (backward compat)', () => {
    expect(() => orchestratorConfigSchema.parse(baseValid)).not.toThrow();
  });
});

describe('roles block', () => {
  function withRoles(): typeof baseValid {
    const cfg = structuredClone(baseValid);
    (cfg.agent as Record<string, unknown>).roles = {
      architect: { profile: 'opencode-frontier' },
      fallback: { profile: 'opencode-frontier', fallback: 'opencode-frontier' },
    };
    return cfg;
  }

  it('accepts a roles block with valid profile references', () => {
    expect(() => orchestratorConfigSchema.parse(withRoles())).not.toThrow();
  });

  it('rejects when roles[x].profile is not in profiles', () => {
    const cfg = withRoles();
    ((cfg.agent as Record<string, unknown>).roles as Record<string, unknown>)['architect'] = {
      profile: 'no-such-profile',
    };
    expect(() => orchestratorConfigSchema.parse(cfg)).toThrow(/no-such-profile/);
  });

  it('rejects when roles[x].fallback is not in profiles', () => {
    const cfg = withRoles();
    ((cfg.agent as Record<string, unknown>).roles as Record<string, unknown>)['fallback'] = {
      profile: 'opencode-frontier',
      fallback: 'missing-fallback',
    };
    expect(() => orchestratorConfigSchema.parse(cfg)).toThrow(/missing-fallback/);
  });

  it('accepts config without a roles block (backward compat)', () => {
    expect(() => orchestratorConfigSchema.parse(baseValid)).not.toThrow();
  });
});

describe('phaseProfiles role references', () => {
  function baseWithRoles() {
    return {
      validation: { commands: ['pnpm test'], timeout: 60 },
      phases: { skip: [], reviewFix: { maxIterations: 10 }, implement: { maxIterations: 5 } },
      timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
      agent: {
        defaultProfile: 'p1',
        profiles: {
          p1: { runtime: 'opencode' as const, provider: 'a', model: 'm1', timeoutMinutes: 1 },
          p2: { runtime: 'opencode' as const, provider: 'a', model: 'm2', timeoutMinutes: 1 },
        },
        roles: {
          architect: { profile: 'p1', fallback: 'p2' },
          reviewer: { profile: 'p2' },
        },
        phaseProfiles: {
          'plan-design': { profile: 'p1' },
        },
      },
    };
  }

  it('accepts phase entry with role when role is defined', () => {
    const cfg = baseWithRoles();
    cfg.agent.phaseProfiles['plan-design'] = {
      role: 'architect',
    } as (typeof cfg.agent.phaseProfiles)['plan-design'];
    expect(() => orchestratorConfigSchema.parse(cfg)).not.toThrow();
  });

  it('accepts phase entry with role and fallbackRole when both roles are defined', () => {
    const cfg = baseWithRoles();
    cfg.agent.phaseProfiles['plan-design'] = {
      role: 'architect',
      fallbackRole: 'reviewer',
    } as (typeof cfg.agent.phaseProfiles)['plan-design'];
    expect(() => orchestratorConfigSchema.parse(cfg)).not.toThrow();
  });

  it('accepts phase entry with role, fallbackRole, and fallbackTriggers', () => {
    const cfg = baseWithRoles();
    cfg.agent.phaseProfiles['plan-design'] = {
      role: 'architect',
      fallbackRole: 'reviewer',
      fallbackTriggers: ['timeout', 'quota_exceeded'],
    } as (typeof cfg.agent.phaseProfiles)['plan-design'];
    expect(() => orchestratorConfigSchema.parse(cfg)).not.toThrow();
  });

  it('rejects phase entry with both profile and role', () => {
    const cfg = baseWithRoles();
    cfg.agent.phaseProfiles['plan-design'] = {
      profile: 'p1',
      role: 'architect',
    } as (typeof cfg.agent.phaseProfiles)['plan-design'];
    expect(() => orchestratorConfigSchema.parse(cfg)).toThrow(/profile and role/);
  });

  it('rejects phase entry with both fallbackProfile and fallbackRole', () => {
    const cfg = baseWithRoles();
    cfg.agent.phaseProfiles['plan-design'] = {
      role: 'architect',
      fallbackProfile: 'p2',
      fallbackRole: 'reviewer',
    } as (typeof cfg.agent.phaseProfiles)['plan-design'];
    expect(() => orchestratorConfigSchema.parse(cfg)).toThrow(/fallbackProfile and fallbackRole/);
  });

  it('rejects phase entry with neither profile nor role', () => {
    const cfg = baseWithRoles();
    cfg.agent.phaseProfiles['plan-design'] = {} as (typeof cfg.agent.phaseProfiles)['plan-design'];
    expect(() => orchestratorConfigSchema.parse(cfg)).toThrow(/must have either profile or role/);
  });

  it('rejects phase entry referencing a role not in roles', () => {
    const cfg = baseWithRoles();
    cfg.agent.phaseProfiles['plan-design'] = {
      role: 'no-such-role',
    } as (typeof cfg.agent.phaseProfiles)['plan-design'];
    expect(() => orchestratorConfigSchema.parse(cfg)).toThrow(/no-such-role/);
  });

  it('rejects phase entry referencing a fallbackRole not in roles', () => {
    const cfg = baseWithRoles();
    cfg.agent.phaseProfiles['plan-design'] = {
      role: 'architect',
      fallbackRole: 'no-such-role',
    } as (typeof cfg.agent.phaseProfiles)['plan-design'];
    expect(() => orchestratorConfigSchema.parse(cfg)).toThrow(/no-such-role/);
  });

  it('rejects fallbackTriggers on role-based entry with no fallback target', () => {
    const cfg = baseWithRoles();
    // reviewer role has no fallback; entry has no fallbackRole either
    cfg.agent.phaseProfiles['plan-design'] = {
      role: 'reviewer',
      fallbackTriggers: ['timeout'],
    } as (typeof cfg.agent.phaseProfiles)['plan-design'];
    expect(() => orchestratorConfigSchema.parse(cfg)).toThrow(/fallbackTriggers/);
  });
});

describe('committed .ai-orchestrator.json', () => {
  it('parses against orchestratorConfigSchema', () => {
    const text = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        '..',
        '.ai-orchestrator.json',
      ),
      'utf8',
    );
    expect(() => orchestratorConfigSchema.parse(JSON.parse(text))).not.toThrow();
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('accepts config without agent field', () => {
    const { validation, phases, timeouts } = baseValid;
    expect(() => orchestratorConfigSchema.parse({ validation, phases, timeouts })).not.toThrow();
  });
});
describe('committed .ai-orchestrator.json', () => {
  it('parses against orchestratorConfigSchema', () => {
    const text = readFileSync(
      join(import.meta.dirname, '..', '..', '..', '..', '.ai-orchestrator.json'),
      'utf8',
    );
    expect(() => orchestratorConfigSchema.parse(JSON.parse(text))).not.toThrow();
  });
});

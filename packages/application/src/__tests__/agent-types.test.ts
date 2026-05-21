import { describe, expect, it } from 'vitest';
import {
  isOpencodeProfile,
  isPiProfile,
  validateAgentProfile,
  AgentProfileName,
  type AgentProfile,
} from '../agent/types.js';

describe('AgentProfileName', () => {
  it('throws for empty string', () => {
    expect(() => AgentProfileName('')).toThrow('non-empty string');
  });

  it('throws for whitespace-only string', () => {
    expect(() => AgentProfileName('   ')).toThrow('non-empty string');
  });

  it('returns the branded type for a valid string', () => {
    const name = AgentProfileName('test-profile');
    expect(name).toBe('test-profile');
  });
});

function opencodeProfile(overrides?: Partial<AgentProfile>): AgentProfile {
  return {
    runtime: 'opencode',
    provider: 'anthropic',
    model: 'claude-opus-4.7',
    timeoutMinutes: 30,
    ...overrides,
  };
}

function piProfile(overrides?: Partial<AgentProfile>): AgentProfile {
  return {
    runtime: 'pi',
    provider: 'qwen',
    model: 'qwen-2.5-32b',
    contextLimitTokens: 128_000,
    timeoutMinutes: 10,
    ...overrides,
  };
}

describe('isOpencodeProfile', () => {
  it('returns true for opencode profile', () => {
    expect(isOpencodeProfile(opencodeProfile())).toBe(true);
  });

  it('returns false for pi profile', () => {
    expect(isOpencodeProfile(piProfile())).toBe(false);
  });
});

describe('isPiProfile', () => {
  it('returns true for pi profile', () => {
    expect(isPiProfile(piProfile())).toBe(true);
  });

  it('returns false for opencode profile', () => {
    expect(isPiProfile(opencodeProfile())).toBe(false);
  });
});

describe('validateAgentProfile', () => {
  it('accepts a well-formed OpenCode profile', () => {
    expect(() => validateAgentProfile(AgentProfileName('test'), opencodeProfile())).not.toThrow();
  });

  it('accepts a well-formed Pi profile', () => {
    expect(() => validateAgentProfile(AgentProfileName('test'), piProfile())).not.toThrow();
  });

  it('rejects empty provider', () => {
    expect(() =>
      validateAgentProfile(AgentProfileName('bad'), opencodeProfile({ provider: '' })),
    ).toThrow('empty provider');
  });

  it('rejects empty model', () => {
    expect(() =>
      validateAgentProfile(AgentProfileName('bad'), opencodeProfile({ model: '' })),
    ).toThrow('empty model');
  });

  it.each([0, -1])('rejects timeoutMinutes=%s', (timeoutMinutes) => {
    expect(() =>
      validateAgentProfile(AgentProfileName('bad-timeout'), opencodeProfile({ timeoutMinutes })),
    ).toThrow('non-positive timeoutMinutes');
  });

  it('rejects a Pi profile missing contextLimitTokens', () => {
    expect(() =>
      validateAgentProfile(
        AgentProfileName('pi-no-ctx'),
        piProfile({ contextLimitTokens: undefined }),
      ),
    ).toThrow('contextLimitTokens');
  });

  it('accepts Pi profile with contextLimitTokens: 0', () => {
    expect(() =>
      validateAgentProfile(AgentProfileName('pi-zero-ctx'), piProfile({ contextLimitTokens: 0 })),
    ).not.toThrow();
  });

  it('accepts Pi profile with negative contextLimitTokens (currently passes, regression guard)', () => {
    expect(() =>
      validateAgentProfile(AgentProfileName('pi-neg-ctx'), piProfile({ contextLimitTokens: -1 })),
    ).not.toThrow();
  });

  it('accepts Pi profile with NaN contextLimitTokens (currently passes, regression guard)', () => {
    expect(() =>
      validateAgentProfile(
        AgentProfileName('pi-nan-ctx'),
        piProfile({ contextLimitTokens: Number.NaN }),
      ),
    ).not.toThrow();
  });
});

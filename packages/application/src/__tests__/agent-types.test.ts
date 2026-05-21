import { describe, expect, it } from 'vitest';
import {
  isOpencodeProfile,
  isPiProfile,
  validateAgentProfile,
  AgentProfileName,
  type AgentProfile,
} from '../agent/types.js';

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

  it('rejects a Pi profile missing contextLimitTokens', () => {
    expect(() =>
      validateAgentProfile(
        AgentProfileName('pi-no-ctx'),
        piProfile({ contextLimitTokens: undefined }),
      ),
    ).toThrow('contextLimitTokens');
  });

  it('rejects any profile with non-positive timeoutMinutes', () => {
    expect(() =>
      validateAgentProfile(AgentProfileName('bad-timeout'), opencodeProfile({ timeoutMinutes: 0 })),
    ).toThrow('non-positive timeoutMinutes');
  });

  it('rejects negative timeoutMinutes', () => {
    expect(() =>
      validateAgentProfile(
        AgentProfileName('neg-timeout'),
        opencodeProfile({ timeoutMinutes: -1 }),
      ),
    ).toThrow('non-positive timeoutMinutes');
  });
});

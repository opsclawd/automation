import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLayeredConfig, loadConfig } from '../loader.js';

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'layered-config-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

const BASE_CONFIG = {
  validation: { commands: ['pnpm build'], timeout: 300 },
  phases: {
    skip: [],
    reviewFix: { maxIterations: 10 },
    implement: { maxIterations: 5 },
  },
  timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
};

function validConfig(overrides: Record<string, unknown> = {}): string {
  const result = JSON.parse(JSON.stringify(BASE_CONFIG)) as Record<string, unknown>;
  const deepMerge = (target: Record<string, unknown>, source: Record<string, unknown>) => {
    for (const key of Object.keys(source)) {
      const sourceVal = source[key];
      if (sourceVal && typeof sourceVal === 'object' && !Array.isArray(sourceVal)) {
        let targetVal = target[key];
        if (!targetVal || typeof targetVal !== 'object') {
          targetVal = {};
          target[key] = targetVal;
        }
        deepMerge(targetVal as Record<string, unknown>, sourceVal as Record<string, unknown>);
      } else {
        target[key] = sourceVal;
      }
    }
  };
  deepMerge(result, overrides);
  return JSON.stringify(result);
}

describe('loadLayeredConfig', () => {
  it('returns sources and fingerprint for layer-1 only', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': validConfig({ validation: { commands: ['pnpm test'] } }),
    });

    const result = loadLayeredConfig({ automationRoot });

    expect(result.config.validation.commands).toEqual(['pnpm test']);
    expect(result.sources).toHaveLength(4);
    expect(result.sources[0]).toMatchObject({ kind: 'automation', present: true });
    expect(result.sources.slice(1).every((s) => s.present === false)).toBe(true);
    expect(typeof result.fingerprint).toBe('string');
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('declares four source entries with the documented precedence ordering', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': validConfig({ validation: { commands: ['a'] } }),
    });

    const result = loadLayeredConfig({ automationRoot });

    expect(result.sources.map((s) => s.kind)).toEqual(['automation', 'local', 'target', 'local']);
    expect(result.sources[0].path.endsWith('.ai-orchestrator.json')).toBe(true);
    expect(result.sources[1].path.endsWith('.ai-orchestrator.local.json')).toBe(true);
    expect(result.sources[2].path.endsWith('.ai-orchestrator.json')).toBe(true);
    expect(result.sources[3].path.endsWith('.ai-orchestrator.local.json')).toBe(true);
  });

  it('merges automation local after automation base (deep merge on objects)', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': validConfig({
        validation: { commands: ['pnpm build'], timeouts: { build: 60 } },
      }),
      '.ai-orchestrator.local.json': JSON.stringify({
        validation: { timeouts: { build: 120, lint: 30 } },
      }),
    });

    const result = loadLayeredConfig({ automationRoot });

    expect(result.config.validation.commands).toEqual(['pnpm build']);
    expect(
      (result.rawMergedJson as { validation: { timeouts: Record<string, number> } }).validation
        .timeouts,
    ).toEqual({ build: 120, lint: 30 });
    expect(result.sources[1].present).toBe(true);
  });

  it('applies target base after automation local (target overrides same key)', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': validConfig({ validation: { commands: ['a'] } }),
      '.ai-orchestrator.local.json': JSON.stringify({ validation: { commands: ['b'] } }),
    });
    const targetRoot = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({ validation: { commands: ['t'] } }),
    });

    const result = loadLayeredConfig({ automationRoot, targetRoot });

    expect(result.config.validation.commands).toEqual(['a', 'b', 't']);
  });

  it('applies target local after target base', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': validConfig({ validation: { commands: ['a'] } }),
    });
    const targetRoot = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({ validation: { commands: ['t-base'] } }),
      '.ai-orchestrator.local.json': JSON.stringify({ validation: { commands: ['t-local'] } }),
    });

    const result = loadLayeredConfig({ automationRoot, targetRoot });

    expect(result.config.validation.commands).toEqual(['a', 't-base', 't-local']);
  });

  it('silently skips absent target layers', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': validConfig({ validation: { commands: ['a'] } }),
    });

    const result = loadLayeredConfig({
      automationRoot,
      targetRoot: mkdtempSync(join(tmpdir(), 'empty-target-')),
    });

    expect(result.config.validation.commands).toEqual(['a']);
    expect(result.sources[2].present).toBe(false);
    expect(result.sources[3].present).toBe(false);
  });

  it('omits targetRoot entirely when not provided (back-compat)', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': validConfig({ validation: { commands: ['a'] } }),
      '.ai-orchestrator.local.json': JSON.stringify({ validation: { commands: ['b'] } }),
    });

    const result = loadLayeredConfig({ automationRoot });

    expect(result.sources[2].path).toContain('.ai-orchestrator.json');
    expect(result.sources[2].path).toContain(automationRoot);
    expect(result.config.validation.commands).toEqual(['a', 'b']);
  });

  it('replaces agent.phaseProfiles wholesale (not key-by-key)', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': validConfig({
        agent: {
          defaultProfile: 'implementer',
          profiles: {
            implementer: {
              runtime: 'opencode',
              provider: 'openai',
              model: 'gpt-4',
              timeoutMinutes: 10,
            },
            'target-implementer': {
              runtime: 'opencode',
              provider: 'openai',
              model: 'gpt-4',
              timeoutMinutes: 10,
            },
          },
          phaseProfiles: {
            implement: { profile: 'implementer', role: 'implementer-role' },
          },
        },
      }),
    });
    const targetRoot = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({
        agent: {
          phaseProfiles: {
            implement: { profile: 'target-implementer' },
          },
        },
      }),
    });

    const result = loadLayeredConfig({ automationRoot, targetRoot });

    expect(result.config.agent.phaseProfiles.implement).toEqual({
      profile: 'target-implementer',
    });
  });

  it('merges phases.skip arrays index-by-index (jq * semantics)', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': validConfig({ phases: { skip: ['a', 'b'] } }),
    });
    const targetRoot = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({ phases: { skip: ['c'] } }),
    });

    const result = loadLayeredConfig({ automationRoot, targetRoot });

    expect(result.config.phases.skip).toEqual(['c', 'b']);
  });

  it('names every contributing source path in ConfigError when merged schema fails', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({ validation: { commands: [123] } }),
    });

    expect(() => loadLayeredConfig({ automationRoot })).toThrow(/commands/);
  });

  it('throws ConfigError naming target path when target base JSON is malformed', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({ validation: { commands: ['a'] } }),
    });
    const targetRoot = makeRepo({
      '.ai-orchestrator.json': '{not json',
    });

    expect(() => loadLayeredConfig({ automationRoot, targetRoot })).toThrow(
      /Invalid JSON in .*\.ai-orchestrator\.json/,
    );
  });

  it('throws ConfigError naming local path when local JSON is malformed', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({ validation: { commands: ['a'] } }),
      '.ai-orchestrator.local.json': '{not json',
    });

    expect(() => loadLayeredConfig({ automationRoot })).toThrow(/Invalid JSON in .*\.local\.json/);
  });
});

describe('loadConfig (back-compat wrapper)', () => {
  it('returns OrchestratorConfig only (no sources/fingerprint)', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': validConfig({ validation: { commands: ['pnpm test'] } }),
    });

    const config = loadConfig(automationRoot);
    expect(config.validation.commands).toEqual(['pnpm test']);
  });
});

describe('loadLayeredConfig warnOnRetiredArbiterPhaseKey', () => {
  it('emits console.warn when phaseProfiles.arbitrate is present in merged config', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const automationRoot = makeRepo({
        '.ai-orchestrator.json': validConfig({
          agent: {
            defaultProfile: 'opencode-frontier',
            profiles: {
              'opencode-frontier': {
                runtime: 'opencode',
                provider: 'anthropic',
                model: 'm',
                timeoutMinutes: 1,
              },
            },
            phaseProfiles: {
              arbitrate: { profile: 'opencode-frontier' },
            },
          },
        }),
      });

      loadLayeredConfig({ automationRoot });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toContain("phaseProfiles['arbitrate']");
      expect(spy.mock.calls[0]?.[0]).toContain('arbiter');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not emit console.warn when phaseProfiles.arbitrate is absent', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const automationRoot = makeRepo({
        '.ai-orchestrator.json': validConfig({
          agent: {
            defaultProfile: 'opencode-frontier',
            profiles: {
              'opencode-frontier': {
                runtime: 'opencode',
                provider: 'anthropic',
                model: 'm',
                timeoutMinutes: 1,
              },
            },
            phaseProfiles: {
              arbiter: { profile: 'opencode-frontier' },
            },
          },
        }),
      });

      loadLayeredConfig({ automationRoot });

      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('does not emit console.warn when the config has no agent block', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const automationRoot = makeRepo({
        '.ai-orchestrator.json': validConfig({}),
      });

      loadLayeredConfig({ automationRoot });

      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

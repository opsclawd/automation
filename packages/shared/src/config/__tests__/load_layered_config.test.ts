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

  it('target commands replace inherited commands with a smaller deduplicated set', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': validConfig({
        validation: {
          commands: [
            'pnpm build',
            'pnpm typecheck',
            'pnpm lint',
            'pnpm test',
            'pnpm test:bash',
            'pnpm boundaries',
          ],
        },
      }),
    });
    const targetRoot = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({
        validation: {
          commands: ['pnpm typecheck', 'pnpm lint', 'pnpm test', 'pnpm test', 'pnpm build'],
        },
      }),
    });

    const result = loadLayeredConfig({ automationRoot, targetRoot });

    expect(result.config.validation.commands).toEqual([
      'pnpm typecheck',
      'pnpm lint',
      'pnpm test',
      'pnpm build',
    ]);
    expect(result.sources[2].present).toBe(true);
  });

  it('target additionalCommands append without duplicating inherited commands', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': validConfig({
        validation: {
          commands: ['pnpm build', 'pnpm test', 'pnpm lint'],
        },
      }),
    });
    const targetRoot = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({
        validation: {
          additionalCommands: ['pnpm test', 'pnpm format'],
        },
      }),
    });

    const result = loadLayeredConfig({ automationRoot, targetRoot });

    expect(result.config.validation.commands).toEqual([
      'pnpm build',
      'pnpm test',
      'pnpm lint',
      'pnpm format',
    ]);
  });

  it('deduplicates additions across layers in first-surviving order', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': validConfig({
        validation: { commands: ['a', 'b'] },
      }),
      '.ai-orchestrator.local.json': JSON.stringify({
        validation: { additionalCommands: ['c', 'b', 'd'] },
      }),
    });
    const targetRoot = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({
        validation: { additionalCommands: ['e', 'c', 'f'] },
      }),
      '.ai-orchestrator.local.json': JSON.stringify({
        validation: { additionalCommands: ['g', 'd', 'e', 'h'] },
      }),
    });

    const result = loadLayeredConfig({ automationRoot, targetRoot });

    expect(result.config.validation.commands).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });

  it('target local commands replace target base commands', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': validConfig({
        validation: { commands: ['auto-1', 'auto-2'] },
      }),
    });
    const targetRoot = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({
        validation: { commands: ['t-base-1', 't-base-2'] },
      }),
      '.ai-orchestrator.local.json': JSON.stringify({
        validation: { commands: ['t-local-1', 't-local-2'] },
      }),
    });

    const result = loadLayeredConfig({ automationRoot, targetRoot });

    expect(result.config.validation.commands).toEqual(['t-local-1', 't-local-2']);
  });

  it('a target without validation command directives inherits automation commands', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': validConfig({
        validation: { commands: ['pnpm build', 'pnpm test'] },
      }),
    });
    const targetRoot = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({
        validation: { timeout: 600 },
      }),
    });

    const result = loadLayeredConfig({ automationRoot, targetRoot });

    expect(result.config.validation.commands).toEqual(['pnpm build', 'pnpm test']);
    expect(result.config.validation.timeout).toBe(600);
  });

  it('target command replacement clears inherited tiers', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': validConfig({
        validation: {
          commands: ['pnpm build', 'pnpm test', 'pnpm lint'],
          tiers: [['pnpm build'], ['pnpm test', 'pnpm lint']],
        },
      }),
    });
    const targetRoot = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({
        validation: {
          commands: ['pnpm test', 'pnpm lint'],
        },
      }),
    });

    const result = loadLayeredConfig({ automationRoot, targetRoot });

    expect(result.config.validation.commands).toEqual(['pnpm test', 'pnpm lint']);
    expect(result.config.validation.tiers).toBeUndefined();
    expect(
      (result.rawMergedJson as { validation: { tiers?: unknown } }).validation.tiers,
    ).toBeUndefined();
  });

  it('target tiers replace inherited tiers and normalize against effective commands', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': validConfig({
        validation: {
          commands: ['a', 'b', 'c', 'd'],
          tiers: [['a'], ['b', 'c']],
        },
      }),
    });
    const targetRoot = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({
        validation: {
          commands: ['a', 'c', 'e'],
          tiers: [['a', 'x'], ['c', 'a'], ['y'], ['e']],
        },
      }),
    });

    const result = loadLayeredConfig({ automationRoot, targetRoot });

    expect(result.config.validation.commands).toEqual(['a', 'c', 'e']);
    expect(result.config.validation.tiers).toEqual([['a'], ['c'], ['e']]);
  });

  it('additionalCommands-only targets retain inherited tiers', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': validConfig({
        validation: {
          commands: ['a', 'b'],
          tiers: [['a'], ['b']],
        },
      }),
    });
    const targetRoot = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({
        validation: {
          additionalCommands: ['c'],
        },
      }),
    });

    const result = loadLayeredConfig({ automationRoot, targetRoot });

    expect(result.config.validation.commands).toEqual(['a', 'b', 'c']);
    expect(result.config.validation.tiers).toEqual([['a'], ['b']]);
  });

  it('rawMergedJson and fingerprint represent the resolved executable policy', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': validConfig({
        validation: { commands: ['pnpm build', 'pnpm test'] },
      }),
    });
    const targetRoot1 = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({
        validation: { commands: ['pnpm test'] },
      }),
    });
    const targetRoot2 = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({
        validation: { commands: ['pnpm build'] },
      }),
    });

    const result1 = loadLayeredConfig({ automationRoot, targetRoot: targetRoot1 });
    const result2 = loadLayeredConfig({ automationRoot, targetRoot: targetRoot2 });

    expect(result1.fingerprint).not.toEqual(result2.fingerprint);
    expect(
      (result1.rawMergedJson as { validation: { commands: string[] } }).validation.commands,
    ).toEqual(['pnpm test']);
    expect(result1.config.validation.commands).toEqual(['pnpm test']);
    expect(
      (result2.rawMergedJson as { validation: { commands: string[] } }).validation.commands,
    ).toEqual(['pnpm build']);
    expect(result2.config.validation.commands).toEqual(['pnpm build']);
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

  describe('phases.architectureReview configuration', () => {
    it('defaults maxCorrections to 2 when omitted', () => {
      const automationRoot = makeRepo({
        '.ai-orchestrator.json': validConfig({}),
      });

      const result = loadLayeredConfig({ automationRoot });
      expect(result.config.phases.architectureReview).toEqual({ maxCorrections: 2 });
    });

    it('accepts explicit maxCorrections within 0..5', () => {
      const automationRoot = makeRepo({
        '.ai-orchestrator.json': validConfig({
          phases: {
            ...BASE_CONFIG.phases,
            architectureReview: { maxCorrections: 0 },
          },
        }),
      });

      const result = loadLayeredConfig({ automationRoot });
      expect(result.config.phases.architectureReview).toEqual({ maxCorrections: 0 });
    });

    it('rejects maxCorrections outside 0..5', () => {
      const automationRoot = makeRepo({
        '.ai-orchestrator.json': validConfig({
          phases: {
            ...BASE_CONFIG.phases,
            architectureReview: { maxCorrections: 6 },
          },
        }),
      });

      expect(() => loadLayeredConfig({ automationRoot })).toThrow();
    });
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../loader.js';
import { ConfigError } from '../errors.js';

const createdDirs: string[] = [];

function makeRepo(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-cfg-'));
  createdDirs.push(dir);
  if (contents !== undefined) writeFileSync(join(dir, '.ai-orchestrator.json'), contents);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  createdDirs.length = 0;
});

function writeLocalConfig(dir: string, contents: string): void {
  writeFileSync(join(dir, '.ai-orchestrator.local.json'), contents);
}

const BASE_CONFIG = JSON.stringify({
  validation: { commands: ['pnpm build'], timeout: 300 },
  phases: {
    skip: [],
  },
  timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
});

const BASE_WITH_AGENT = JSON.stringify({
  validation: { commands: ['pnpm build'], timeout: 300 },
  phases: {
    skip: [],
  },
  timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  agent: {
    defaultProfile: 'senior',
    profiles: {
      senior: { runtime: 'opencode', provider: 'openai', model: 'gpt-4', timeoutMinutes: 5 },
      junior: { runtime: 'opencode', provider: 'openai', model: 'gpt-3.5', timeoutMinutes: 3 },
    },
    phaseProfiles: {
      implement: { profile: 'senior' },
      review: { profile: 'junior' },
    },
  },
});

describe('loadConfig', () => {
  it('parses a valid config', () => {
    const repo = makeRepo(
      JSON.stringify({
        validation: { commands: ['pnpm build'], timeout: 300 },
        phases: {
          skip: ['compound'],
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

  it('defaults phases.implement.exemptUndeclaredFiles to empty array', () => {
    const repo = makeRepo(BASE_CONFIG);
    const cfg = loadConfig(repo);
    expect(cfg.phases.implement.exemptUndeclaredFiles).toEqual([]);
  });

  it('parses phases.implement.exemptUndeclaredFiles when provided', () => {
    const repo = makeRepo(
      JSON.stringify({
        validation: { commands: ['pnpm build'], timeout: 300 },
        phases: {
          implement: { exemptUndeclaredFiles: ['foo/bar.ts'] },
        },
        timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
      }),
    );
    const cfg = loadConfig(repo);
    expect(cfg.phases.implement.exemptUndeclaredFiles).toEqual(['foo/bar.ts']);
  });

  it('defaults phases.reviewConvergence.maxIterations to 4 when present without maxIterations', () => {
    const repo = makeRepo(
      JSON.stringify({
        validation: { commands: ['pnpm build'], timeout: 300 },
        phases: {
          reviewConvergence: {},
        },
        timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
      }),
    );
    const cfg = loadConfig(repo);
    expect(cfg.phases.reviewConvergence?.maxIterations).toBe(4);
  });
});

describe('loadConfig with local override', () => {
  it('returns base config when no local file exists', () => {
    const repo = makeRepo(BASE_WITH_AGENT);
    const cfg = loadConfig(repo);
    expect(cfg.agent!.phaseProfiles.implement.profile).toBe('senior');
  });
  it('deep-merges local config on top of base config', () => {
    const repo = makeRepo(BASE_WITH_AGENT);
    writeLocalConfig(
      repo,
      JSON.stringify({
        agent: {
          phaseProfiles: {
            implement: { profile: 'junior' },
          },
        },
      }),
    );
    const cfg = loadConfig(repo);
    expect(cfg.agent!.phaseProfiles.implement.profile).toBe('junior');
    expect(cfg.agent!.phaseProfiles.review.profile).toBe('junior');
    expect(cfg.agent!.profiles.senior).toBeDefined();
    expect(cfg.validation.commands).toEqual(['pnpm build']);
  });
  it('throws ConfigError for invalid JSON in local config', () => {
    const repo = makeRepo(BASE_CONFIG);
    writeLocalConfig(repo, '{ not json');
    expect(() => loadConfig(repo)).toThrow(ConfigError);
    expect(() => loadConfig(repo)).toThrow(/\.ai-orchestrator\.local\.json/);
  });
  it('throws ConfigError when merged result fails schema', () => {
    const repo = makeRepo(BASE_WITH_AGENT);
    writeLocalConfig(
      repo,
      JSON.stringify({
        agent: {
          phaseProfiles: {
            implement: { profile: 'nonexistent' },
          },
        },
      }),
    );
    expect(() => loadConfig(repo)).toThrow(ConfigError);
    expect(() => loadConfig(repo)).toThrow(/phaseProfiles\.implement\.profile/);
  });
  it('allows local file to add new profile entries', () => {
    const repo = makeRepo(BASE_WITH_AGENT);
    writeLocalConfig(
      repo,
      JSON.stringify({
        agent: {
          profiles: {
            fast: {
              runtime: 'opencode',
              provider: 'openai',
              model: 'fast-model',
              timeoutMinutes: 2,
            },
          },
          phaseProfiles: {
            compound: { profile: 'fast' },
          },
        },
      }),
    );
    const cfg = loadConfig(repo);
    expect(cfg.agent!.profiles.fast).toBeDefined();
    expect(cfg.agent!.profiles.fast.model).toBe('fast-model');
    expect(cfg.agent!.phaseProfiles.compound.profile).toBe('fast');
  });
});

describe('DEFAULT_FIRST_REVIEW_GRACE_WINDOW_SECONDS', () => {
  it('is 1800', async () => {
    const mod = await import('../schema.js');
    expect(mod.DEFAULT_FIRST_REVIEW_GRACE_WINDOW_SECONDS).toBe(1800);
  });
});

describe('taskSplitting', () => {
  it('defaults taskSplitting config when omitted', () => {
    const dir = makeRepo(
      JSON.stringify({
        validation: { commands: ['pnpm build'], timeout: 300 },
        phases: {
          skip: [],
        },
        timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
      }),
    );
    const cfg = loadConfig(dir);
    expect(cfg.taskSplitting).toEqual({
      maxTestFileLines: 500,
      maxTestCases: 10,
      blockOversizedTasks: false,
    });
  });

  it('defaults missing fields inside taskSplitting config when partially specified', () => {
    const dir = makeRepo(
      JSON.stringify({
        validation: { commands: ['pnpm build'], timeout: 300 },
        phases: {
          skip: [],
        },
        timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
        taskSplitting: {
          maxTestFileLines: 200,
        },
      }),
    );
    const cfg = loadConfig(dir);
    expect(cfg.taskSplitting).toEqual({
      maxTestFileLines: 200,
      maxTestCases: 10,
      blockOversizedTasks: false,
    });
  });
});

describe('loadConfig role normalization', () => {
  const BASE_WITH_ROLES = JSON.stringify({
    validation: { commands: ['pnpm build'], timeout: 300 },
    phases: {
      skip: [],
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
    agent: {
      defaultProfile: 'p1',
      profiles: {
        p1: { runtime: 'opencode', provider: 'a', model: 'm1', timeoutMinutes: 1 },
        p2: { runtime: 'opencode', provider: 'a', model: 'm2', timeoutMinutes: 1 },
      },
      roles: {
        architect: { profile: 'p1', fallback: 'p2' },
        reviewer: { profile: 'p2' },
      },
      phaseProfiles: {
        implement: { role: 'architect' },
        review: { role: 'reviewer' },
      },
    },
  });

  it('resolves role to profile after loadConfig', () => {
    const dir = makeRepo(BASE_WITH_ROLES);
    const cfg = loadConfig(dir);
    expect(cfg.agent!.phaseProfiles['implement'].profile).toBe('p1');
  });

  it('resolves role fallback to fallbackProfile when role has fallback', () => {
    const dir = makeRepo(BASE_WITH_ROLES);
    const cfg = loadConfig(dir);
    expect(cfg.agent!.phaseProfiles['implement'].fallbackProfile).toBe('p2');
  });

  it('does not set fallbackProfile when role has no fallback', () => {
    const dir = makeRepo(BASE_WITH_ROLES);
    const cfg = loadConfig(dir);
    expect(cfg.agent!.phaseProfiles['review'].fallbackProfile).toBeUndefined();
  });

  it('resolves fallbackRole to fallbackProfile', () => {
    const withFallbackRole = JSON.stringify({
      validation: { commands: ['pnpm build'], timeout: 300 },
      phases: { skip: [] },
      timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
      agent: {
        defaultProfile: 'p1',
        profiles: {
          p1: { runtime: 'opencode', provider: 'a', model: 'm1', timeoutMinutes: 1 },
          p2: { runtime: 'opencode', provider: 'a', model: 'm2', timeoutMinutes: 1 },
        },
        roles: {
          architect: { profile: 'p1' },
          reviewer: { profile: 'p2' },
        },
        phaseProfiles: {
          implement: { role: 'architect', fallbackRole: 'reviewer' },
        },
      },
    });
    const dir = makeRepo(withFallbackRole);
    const cfg = loadConfig(dir);
    expect(cfg.agent!.phaseProfiles['implement'].profile).toBe('p1');
    expect(cfg.agent!.phaseProfiles['implement'].fallbackProfile).toBe('p2');
  });

  it('leaves legacy profile/fallbackProfile entries unchanged', () => {
    const dir = makeRepo(BASE_WITH_AGENT);
    const cfg = loadConfig(dir);
    expect(cfg.agent!.phaseProfiles['implement'].profile).toBe('senior');
    expect(cfg.agent!.phaseProfiles['review'].profile).toBe('junior');
  });
});

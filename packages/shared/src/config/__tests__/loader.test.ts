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
    expect(() => loadConfig(repo)).toThrow(/Invalid JSON/);
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
});

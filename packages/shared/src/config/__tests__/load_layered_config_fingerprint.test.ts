import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLayeredConfig } from '../loader.js';

function write(dir: string, name: string, body: string) {
  writeFileSync(join(dir, name), body);
}

describe('loadLayeredConfig fingerprint', () => {
  it('is stable across JSON key-order permutations of identical inputs', () => {
    const dir1 = mkdtempSync(join(tmpdir(), 'fp-1-'));
    const config1 = JSON.stringify({
      validation: { commands: ['pnpm build'], timeout: 300 },
      phases: {
        skip: [],
        reviewFix: { maxIterations: 10 },
        implement: { maxIterations: 5 },
      },
      timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
    });
    write(dir1, '.ai-orchestrator.json', config1);

    const dir2 = mkdtempSync(join(tmpdir(), 'fp-2-'));
    const config2 = JSON.stringify({
      timeouts: { invocationMaxMinutes: 30, readyMaxDays: 7 },
      validation: { timeout: 300, commands: ['pnpm build'] },
      phases: {
        implement: { maxIterations: 5 },
        reviewFix: { maxIterations: 10 },
        skip: [],
      },
    });
    write(dir2, '.ai-orchestrator.json', config2);

    expect(loadLayeredConfig({ automationRoot: dir1 }).fingerprint).toBe(
      loadLayeredConfig({ automationRoot: dir2 }).fingerprint,
    );
  });

  it('changes when any contributing file content changes', () => {
    const dir1 = mkdtempSync(join(tmpdir(), 'fp-a-'));
    write(
      dir1,
      '.ai-orchestrator.json',
      JSON.stringify({
        validation: { commands: ['pnpm build'], timeout: 300 },
        phases: {
          skip: [],
          reviewFix: { maxIterations: 10 },
          implement: { maxIterations: 5 },
        },
        timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
      }),
    );

    const dir2 = mkdtempSync(join(tmpdir(), 'fp-b-'));
    write(
      dir2,
      '.ai-orchestrator.json',
      JSON.stringify({
        validation: { commands: ['pnpm build'], timeout: 300 },
        phases: {
          skip: [],
          reviewFix: { maxIterations: 10 },
          implement: { maxIterations: 6 },
        },
        timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
      }),
    );

    expect(loadLayeredConfig({ automationRoot: dir1 }).fingerprint).not.toBe(
      loadLayeredConfig({ automationRoot: dir2 }).fingerprint,
    );
  });
});

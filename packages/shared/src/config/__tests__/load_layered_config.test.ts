import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLayeredConfig } from '../loader.js';

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'layered-config-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

describe('loadLayeredConfig', () => {
  it('returns sources and fingerprint for layer-1 only', () => {
    const automationRoot = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({ validation: { commands: ['pnpm test'] } }),
    });

    const result = loadLayeredConfig({ automationRoot });

    expect(result.config.validation.commands).toEqual(['pnpm test']);
    expect(result.sources).toHaveLength(4);
    expect(result.sources[0]).toMatchObject({ kind: 'automation', present: true });
    expect(result.sources.slice(1).every((s) => s.present === false)).toBe(true);
    expect(typeof result.fingerprint).toBe('string');
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});

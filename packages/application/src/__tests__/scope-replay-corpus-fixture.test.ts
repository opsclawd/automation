import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

interface FixtureEntry {
  runId: string;
  issueNumber: number;
  repo: string;
  path: string;
  taskManifest: Record<string, unknown> | null;
  failureKind: string;
  rawMessage: string;
  label: 'false_positive' | 'true_positive' | null;
  rationale: string | null;
}

describe('scope-replay-corpus.json fixture', () => {
  const fixturePath = join(__dirname, '../__fixtures__/scope-replay-corpus.json');

  it('exists on disk as a static JSON artifact', () => {
    expect(existsSync(fixturePath)).toBe(true);
  });

  it('contains properly formatted, hand-labeled entries for all six boundary-halt runs', () => {
    const raw = readFileSync(fixturePath, 'utf8');
    const entries = JSON.parse(raw) as FixtureEntry[];

    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBe(43);

    const runIds = new Set(entries.map((e) => e.runId));
    expect(runIds).toEqual(
      new Set([
        '09f73f6f-eede-42fe-aaf4-694abc8ab686',
        'e0c4dd03-da65-4a26-97dd-5a2a6e52520c',
        'ff2e91bc-eb8b-4eff-91c6-5b067f5d1e04',
        '8ec8d952-21cc-423a-b8bf-025db1e2c7b2',
        '5dc78eb1-157a-4118-8894-631df496d448',
        '891a6fec-47b3-46b4-8983-cc954eabda6d',
      ]),
    );

    for (const entry of entries) {
      expect(entry.runId).toBeTruthy();
      expect(typeof entry.issueNumber).toBe('number');
      expect(entry.repo).toBeTruthy();
      expect(entry.path).toBeTruthy();
      expect(entry.failureKind).toBeTruthy();
      expect(entry.rawMessage).toBeTruthy();
      expect(['false_positive', 'true_positive']).toContain(entry.label);
      expect(typeof entry.rationale).toBe('string');
      expect(entry.rationale?.length).toBeGreaterThan(10);
    }
  });
});

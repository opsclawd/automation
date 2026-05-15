import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunDirectory } from '../run-directory.js';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'ai-orch-rd-'));
}

describe('RunDirectory', () => {
  it('creates the expected subdirectories', () => {
    const root = makeRoot();
    const dir = RunDirectory.create({
      rootDir: root,
      run: {
        uuid: 'u1',
        displayId: 'issue-1-20260513-000000',
        issueNumber: 1,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T00:00:00Z'),
      },
    });
    expect(existsSync(dir.runRoot)).toBe(true);
    expect(existsSync(join(dir.runRoot, 'phases'))).toBe(true);
    expect(existsSync(join(dir.runRoot, 'artifacts'))).toBe(true);
    expect(existsSync(join(dir.runRoot, 'run.json'))).toBe(true);
  });

  it('writes run.json atomically and re-readable', () => {
    const root = makeRoot();
    const dir = RunDirectory.create({
      rootDir: root,
      run: {
        uuid: 'u2',
        displayId: 'issue-2-20260513-000000',
        issueNumber: 2,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T00:00:00Z'),
      },
    });
    const parsed = JSON.parse(readFileSync(join(dir.runRoot, 'run.json'), 'utf8'));
    expect(parsed.displayId).toBe('issue-2-20260513-000000');
    expect(parsed.status).toBe('running');
  });
});

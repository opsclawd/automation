import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunDirectory, RunDirectoryExistsError } from '../run-directory.js';

const tempRoots: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ai-orch-rd-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function makeRun(overrides: Partial<{ displayId: string; status: string }> = {}) {
  return {
    uuid: 'u1',
    displayId: overrides.displayId ?? 'issue-1-20260513-000000',
    issueNumber: 1,
    type: 'issue_to_pr' as const,
    status: (overrides.status ?? 'running') as
      | 'running'
      | 'queued'
      | 'waiting'
      | 'passed'
      | 'failed'
      | 'cancelled'
      | 'blocked'
      | 'needs_human_review',
    completedPhases: [],
    startedAt: new Date('2026-05-13T00:00:00Z'),
  };
}

describe('RunDirectory', () => {
  it('creates the expected subdirectories', () => {
    const root = makeRoot();
    const dir = RunDirectory.create({ rootDir: root, run: makeRun() });
    expect(existsSync(dir.runRoot)).toBe(true);
    expect(existsSync(join(dir.runRoot, 'phases'))).toBe(true);
    expect(existsSync(join(dir.runRoot, 'artifacts'))).toBe(true);
    expect(existsSync(join(dir.runRoot, 'run.json'))).toBe(true);
  });

  it('writes run.json atomically and re-readable', () => {
    const root = makeRoot();
    const dir = RunDirectory.create({
      rootDir: root,
      run: makeRun({ displayId: 'issue-2-20260513-000000' }),
    });
    const parsed = JSON.parse(readFileSync(join(dir.runRoot, 'run.json'), 'utf8'));
    expect(parsed.displayId).toBe('issue-2-20260513-000000');
    expect(parsed.status).toBe('running');
  });

  it('rewrites run.json on subsequent writeRunJson calls (rename-over-existing)', () => {
    const root = makeRoot();
    const dir = RunDirectory.create({ rootDir: root, run: makeRun() });
    const updated = { ...makeRun(), status: 'passed' as const };
    dir.writeRunJson(updated);
    const parsed = JSON.parse(readFileSync(join(dir.runRoot, 'run.json'), 'utf8'));
    expect(parsed.status).toBe('passed');
    // No leftover .tmp file
    expect(existsSync(join(dir.runRoot, 'run.json.tmp'))).toBe(false);
  });

  it('throws RunDirectoryExistsError when the run directory already exists (default)', () => {
    const root = makeRoot();
    const run = makeRun({ displayId: 'issue-9-20260513-000000' });
    RunDirectory.create({ rootDir: root, run });
    expect(() => RunDirectory.create({ rootDir: root, run })).toThrow(RunDirectoryExistsError);
  });

  it('reuses an existing directory when ifExists: "reuse" is passed', () => {
    const root = makeRoot();
    const run = makeRun({ displayId: 'issue-10-20260513-000000' });
    RunDirectory.create({ rootDir: root, run });
    const updated = { ...run, status: 'passed' as const };
    const dir = RunDirectory.create({
      rootDir: root,
      run: updated,
      ifExists: 'reuse',
    });
    const parsed = JSON.parse(readFileSync(join(dir.runRoot, 'run.json'), 'utf8'));
    expect(parsed.status).toBe('passed');
  });

  it('openLogStreams writes to the expected files in append mode', async () => {
    const root = makeRoot();
    const dir = RunDirectory.create({
      rootDir: root,
      run: makeRun({ displayId: 'issue-11-20260513-000000' }),
    });
    const streams = dir.openLogStreams();
    streams.stdout.write('hello stdout\n');
    streams.stderr.write('hello stderr\n');
    streams.combined.write('hello combined\n');
    streams.events.write(JSON.stringify({ type: 'started' }) + '\n');
    await streams.closeAll();

    expect(readFileSync(dir.paths.stdoutLogPath, 'utf8')).toBe('hello stdout\n');
    expect(readFileSync(dir.paths.stderrLogPath, 'utf8')).toBe('hello stderr\n');
    expect(readFileSync(dir.paths.combinedLogPath, 'utf8')).toBe('hello combined\n');
    expect(readFileSync(dir.paths.eventsJsonlPath, 'utf8')).toBe('{"type":"started"}\n');

    // Reopen and append — verify append (not truncate) semantics.
    const streams2 = dir.openLogStreams();
    streams2.stdout.write('again\n');
    await streams2.closeAll();
    expect(readFileSync(dir.paths.stdoutLogPath, 'utf8')).toBe('hello stdout\nagain\n');
  });
});

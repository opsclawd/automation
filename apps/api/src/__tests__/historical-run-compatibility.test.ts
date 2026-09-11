import {
  existsSync,
  readFileSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { composeRoot, type Container } from '../compose.js';
import { startServer } from '../server.js';
import { RepositoryId, createRun } from '@ai-sdlc/domain';
import {
  PHASE_NAME_MIGRATION_MAP,
  getPhaseResultMeta,
  normalizePhaseId,
} from '@ai-sdlc/application';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

const stoppers: Array<() => Promise<void>> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (stoppers.length) await stoppers.pop()!();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function bootServer(
  opts: { runsDir?: string; repoRoot?: string; dbPath?: string } = {},
): Promise<{
  baseUrl: string;
  container: Container;
  stop: () => Promise<void>;
}> {
  const root = opts.repoRoot ?? mkdtempSync(join(tmpdir(), 'ai-orch-hist-'));
  if (!opts.repoRoot) tempDirs.push(root);
  const scriptPath = join(root, 'fake.sh');
  if (!existsSync(scriptPath)) {
    writeFileSync(scriptPath, '#!/usr/bin/env bash\necho ok\nexit 0\n');
    chmodSync(scriptPath, 0o755);
  }
  const dbPath = opts.dbPath ?? join(root, 'test-orch.sqlite');
  const container = composeRoot({
    repoRoot: root,
    scriptPath,
    repoFullName: 'owner/repo',
    dbPath,
    ...(opts.runsDir ? { runsDir: opts.runsDir } : {}),
  });
  const server = await startServer({ container, port: 0, forceCloseAllOnStop: true });
  stoppers.push(server.stop);
  const address = server.address as { port: number };
  return { baseUrl: `http://127.0.0.1:${address.port}`, container, stop: server.stop };
}

describe('historical run compatibility ([1096.2])', () => {
  it('inspects a real historical legacy run from .ai-runs data via API and filesystem', async () => {
    // Verified real historical run executed with legacy loops
    const runDisplayId = 'issue-118-20260527-184505327';
    const realRunDir = resolve(repoRoot, '.ai-runs', runDisplayId);
    let targetRunDir = realRunDir;
    let targetRunsParentDir = resolve(repoRoot, '.ai-runs');

    if (!existsSync(realRunDir)) {
      // Fallback fixture for clean CI runners where .ai-runs is gitignored
      const mockRunsDir = mkdtempSync(join(tmpdir(), 'ai-orch-mock-runs-'));
      tempDirs.push(mockRunsDir);
      targetRunsParentDir = mockRunsDir;
      targetRunDir = join(mockRunsDir, runDisplayId);
      mkdirSync(targetRunDir, { recursive: true });
      writeFileSync(
        join(targetRunDir, 'run.json'),
        JSON.stringify({
          uuid: '8a5d0ba1-1772-40a6-92e7-a3021f0c2dab',
          displayId: runDisplayId,
          issueNumber: 118,
          type: 'issue_to_pr',
          status: 'passed',
          completedPhases: [],
          startedAt: '2026-05-27T18:45:05.327Z',
          completedAt: '2026-05-27T21:18:32.610Z',
        }),
      );
      const fixtureEvents = [
        'plan-write',
        'implement',
        'fix-review',
        'validate',
        'whole-pr-review',
        'compound',
        'create-pr',
        'post-pr-review',
      ]
        .map((phase) => JSON.stringify({ phase, timestamp: new Date().toISOString() }))
        .join('\n');
      writeFileSync(join(targetRunDir, 'events.jsonl'), fixtureEvents);
      writeFileSync(join(targetRunDir, 'combined.log'), 'historical combined log content');
      writeFileSync(join(targetRunDir, 'stdout.log'), 'historical stdout log content');
    }

    // 1. Verify run.json metadata
    const runJsonPath = join(targetRunDir, 'run.json');
    expect(existsSync(runJsonPath)).toBe(true);
    const runData = JSON.parse(readFileSync(runJsonPath, 'utf-8'));
    expect(runData.displayId).toBe(runDisplayId);
    expect(runData.issueNumber).toBe(118);
    expect(runData.status).toBe('passed');

    // 2. Verify events.jsonl contains legacy and canonical phase names
    const eventsPath = join(targetRunDir, 'events.jsonl');
    expect(existsSync(eventsPath)).toBe(true);
    const lines = readFileSync(eventsPath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const eventPhases = new Set<string>();
    for (const line of lines) {
      const parsed = JSON.parse(line);
      if (parsed.phase) eventPhases.add(parsed.phase);
    }

    expect(eventPhases.has('plan-write')).toBe(true);
    expect(eventPhases.has('implement')).toBe(true);
    expect(eventPhases.has('fix-review')).toBe(true);
    expect(eventPhases.has('validate')).toBe(true);
    expect(eventPhases.has('whole-pr-review')).toBe(true);
    expect(eventPhases.has('compound')).toBe(true);
    expect(eventPhases.has('create-pr')).toBe(true);
    expect(eventPhases.has('post-pr-review')).toBe(true);

    // 3. Verify serving artifacts of historical run via API
    const { baseUrl, container } = await bootServer({ runsDir: targetRunsParentDir });

    const runUuid = runData.uuid;
    const historicalRun = createRun({
      uuid: runUuid,
      displayId: runDisplayId,
      repoId: RepositoryId('owner/repo'),
      issueNumber: 118,
      startedAt: new Date(runData.startedAt),
      executionPolicy: 'legacy',
    });
    historicalRun.status = 'passed';
    container.runRepository.insertIfNoActive(historicalRun);

    // Read artifacts list via API
    const artRes = await fetch(`${baseUrl}/api/runs/${runUuid}/artifacts`);
    expect(artRes.status).toBe(200);
    const artBody = (await artRes.json()) as { files: Array<{ path: string }> };
    const filePaths = artBody.files.map((f) => f.path);
    expect(filePaths).toContain('run.json');
    expect(filePaths).toContain('combined.log');
    expect(filePaths).toContain('stdout.log');

    // Fetch combined.log artifact via API
    const logRes = await fetch(`${baseUrl}/api/runs/${runUuid}/artifacts/combined.log`);
    expect(logRes.status).toBe(200);
    expect(logRes.headers.get('content-type')).toBe('text/plain');
    const logText = await logRes.text();
    expect(logText.length).toBeGreaterThan(0);
  });

  it('reads and serves a persisted run whose completedPhases includes legacy-only phase names', async () => {
    const { baseUrl, container } = await bootServer();

    const legacyPhases = [
      'plan-design',
      'plan-write',
      'plan-review',
      'implement',
      'validate',
      'review-fix',
      'post-pr-review',
    ];

    const runUuid = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
    const legacyRun = createRun({
      uuid: runUuid,
      displayId: 'issue-42-legacy-test',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 42,
      startedAt: new Date('2026-05-20T10:00:00Z'),
      executionPolicy: 'legacy',
    });
    legacyRun.status = 'passed';
    legacyRun.currentPhase = 'plan-review';
    legacyRun.completedPhases = legacyPhases;

    container.runRepository.insertIfNoActive(legacyRun);

    // 1. Read via domain / repository port
    const retrieved = container.runRepository.findByUuid(runUuid);
    expect(retrieved).toBeDefined();
    expect(retrieved?.executionPolicy).toBe('legacy');
    expect(retrieved?.currentPhase).toBe('plan-review');
    expect(retrieved?.completedPhases).toEqual(legacyPhases);

    // 2. Read via API route GET /api/runs/:runId
    const res = await fetch(`${baseUrl}/api/runs/${runUuid}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: {
        uuid: string;
        displayId: string;
        currentPhase: string;
        completedPhases: string[];
        executionPolicy: string;
      };
    };

    expect(body.run.uuid).toBe(runUuid);
    expect(body.run.currentPhase).toBe('plan-review');
    expect(body.run.completedPhases).toEqual(legacyPhases);
    expect(body.run.executionPolicy).toBe('legacy');

    // 3. Read via API route GET /api/runs list
    const listRes = await fetch(`${baseUrl}/api/runs`);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      runs: Array<{ uuid: string; currentPhase: string; completedPhases: string[] }>;
    };
    const found = listBody.runs.find((r) => r.uuid === runUuid);
    expect(found).toBeDefined();
    expect(found?.completedPhases).toEqual(legacyPhases);
  });

  it('reads historical Milestone 1 run with verify phase', async () => {
    const { baseUrl, container } = await bootServer();

    const m1Uuid = '11111111-2222-3333-4444-555555555555';
    const m1Run = createRun({
      uuid: m1Uuid,
      displayId: 'issue-1-m1-test',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 1,
      startedAt: new Date('2026-05-10T10:00:00Z'),
      executionPolicy: 'legacy',
    });
    m1Run.status = 'passed';
    m1Run.completedPhases = ['implement', 'verify'];

    container.runRepository.insertIfNoActive(m1Run);

    const res = await fetch(`${baseUrl}/api/runs/${m1Uuid}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: { completedPhases: string[] } };
    expect(body.run.completedPhases).toEqual(['implement', 'verify']);
  });

  it('maps result schemas and normalizes phase IDs across all historical phase formats', () => {
    // Structured result producing phases resolve to their schemas
    expect(getPhaseResultMeta('plan-design')).toBeDefined();
    expect(getPhaseResultMeta('implement')).toBeDefined();
    expect(getPhaseResultMeta('pr-review-poll')).toBeDefined(); // resolves to post-pr-review
    expect(getPhaseResultMeta('initial-review')).toBeDefined();
    expect(getPhaseResultMeta('spec-review')).toBeDefined();
    expect(getPhaseResultMeta('quality-review')).toBeDefined();
    expect(getPhaseResultMeta('fix-review')).toBeDefined();
    expect(getPhaseResultMeta('whole-pr-review')).toBeDefined();

    // Task-suffixed and loop-suffixed IDs normalize and resolve
    expect(normalizePhaseId('implement-task-1')).toBe('implement');
    expect(normalizePhaseId('fix-review-loop-2')).toBe('fix-review');
    expect(normalizePhaseId('quality-review-task-2')).toBe('quality-review');
    expect(getPhaseResultMeta('implement-task-1')).toBeDefined();
    expect(getPhaseResultMeta('quality-review-task-2')).toBeDefined();
    expect(getPhaseResultMeta('spec-review-task-3')).toBeDefined();
    expect(getPhaseResultMeta('fix-review-loop-1')).toBeDefined();
    expect(getPhaseResultMeta('arbiter-task-1')).toBeDefined();

    // Non-result-producing phases return undefined
    expect(getPhaseResultMeta('plan-write')).toBeUndefined();
    expect(getPhaseResultMeta('plan-review')).toBeUndefined();
    expect(getPhaseResultMeta('review-fix')).toBeUndefined();
    expect(getPhaseResultMeta('post-pr-review')).toBeUndefined();
    expect(getPhaseResultMeta('validate')).toBeUndefined();
    expect(getPhaseResultMeta('verify')).toBeUndefined();
    expect(getPhaseResultMeta('review')).toBeUndefined();

    // Explicit entries in PHASE_NAME_MIGRATION_MAP
    expect(PHASE_NAME_MIGRATION_MAP['plan-review']).toBeNull();
    expect(PHASE_NAME_MIGRATION_MAP['plan-write']).toBeNull();
    expect(PHASE_NAME_MIGRATION_MAP['review-fix']).toBeNull();
    expect(PHASE_NAME_MIGRATION_MAP['post-pr-review']).toBeNull();
    expect(PHASE_NAME_MIGRATION_MAP['verify']).toBeNull();
    expect(PHASE_NAME_MIGRATION_MAP['review']).toBeNull();
    expect(PHASE_NAME_MIGRATION_MAP['pr-review-poll']).toBe('post-pr-review');
  });
});

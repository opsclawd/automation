import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serializeRun } from '../serializers.js';
import { composeRoot } from '../compose.js';
import { buildServer } from '../server.js';
import { RepositoryId, createRun } from '@ai-sdlc/domain';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-orch-exec-policy-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('serializeRun with executionPolicy', () => {
  it('serializes executionPolicy when set to standard or strict', () => {
    const runStandard = createRun({
      uuid: 'u-1',
      displayId: 'issue-1-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 1,
      startedAt: new Date('2026-05-13T00:00:00Z'),
      executionPolicy: 'standard',
    });
    expect(serializeRun(runStandard).executionPolicy).toBe('standard');

    const runStrict = createRun({
      uuid: 'u-2',
      displayId: 'issue-2-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 2,
      startedAt: new Date('2026-05-13T00:00:00Z'),
      executionPolicy: 'strict',
    });
    expect(serializeRun(runStrict).executionPolicy).toBe('strict');
  });

  it('defaults executionPolicy to legacy when omitted or legacy', () => {
    const runDefault = createRun({
      uuid: 'u-3',
      displayId: 'issue-3-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 3,
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    expect(serializeRun(runDefault).executionPolicy).toBe('legacy');

    const runExplicitLegacy = createRun({
      uuid: 'u-4',
      displayId: 'issue-4-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 4,
      startedAt: new Date('2026-05-13T00:00:00Z'),
      executionPolicy: 'legacy',
    });
    expect(serializeRun(runExplicitLegacy).executionPolicy).toBe('legacy');
  });
});

describe('Execution Policy API and Composition Wiring', () => {
  it('loads executionPolicy from repository config and reflects on Container', () => {
    const dir = createTempDir();
    writeFileSync(
      path.join(dir, '.ai-orchestrator.json'),
      JSON.stringify({
        executionPolicy: 'standard',
        validation: { commands: ['pnpm build'], timeout: 300 },
        phases: {
          skip: [],
          reviewFix: { maxIterations: 10 },
          implement: { maxIterations: 5 },
        },
        timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
      }),
    );

    const c = composeRoot({
      repoRoot: dir,
      scriptPath: '/dev/null',
      repoFullName: 'owner/repo',
      runStartupSweeps: false,
    });

    expect(c.executionPolicy).toBe('standard');
  });

  it('rejects invalid executionPolicy in POST /api/runs with 400', async () => {
    const dir = createTempDir();
    const c = composeRoot({
      repoRoot: dir,
      scriptPath: '/dev/null',
      repoFullName: 'owner/repo',
      runStartupSweeps: false,
    });
    const app = await buildServer(c);

    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        issueNumber: 42,
        executionPolicy: 'invalid_policy',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('invalid_execution_policy');
  });

  it('threads executionPolicy into PhaseHandlerContext via buildRunContext', () => {
    const dir = createTempDir();
    writeFileSync(
      path.join(dir, '.ai-orchestrator.json'),
      JSON.stringify({
        executionPolicy: 'standard',
        validation: { commands: ['pnpm build'], timeout: 300 },
        phases: {
          skip: [],
          reviewFix: { maxIterations: 10 },
          implement: { maxIterations: 5 },
        },
        timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
        agent: {
          defaultProfile: 'opencode-frontier',
          profiles: {
            'opencode-frontier': {
              runtime: 'opencode',
              provider: 'mock',
              model: 'test',
              timeoutMinutes: 10,
            },
          },
          phaseProfiles: {},
        },
      }),
    );

    const c = composeRoot({
      repoRoot: dir,
      scriptPath: '/dev/null',
      repoFullName: 'owner/repo',
      runStartupSweeps: false,
    });

    const run = createRun({
      uuid: 'u-ctx-test',
      displayId: 'issue-42-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 42,
      startedAt: new Date('2026-05-13T00:00:00Z'),
      executionPolicy: 'strict',
    });

    expect(c.buildRunContext).toBeDefined();
    const ctx = c.buildRunContext!(run);
    expect(ctx.executionPolicy).toBe('strict');
  });
});

import { describe, expect, it, afterEach } from 'vitest';
import { RepositoryId } from '@ai-sdlc/domain';
import { composeRoot } from '../compose.js';
import { buildServer } from '../server.js';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDirs: string[] = [];

function compose(tempDir: string) {
  const dbPath = path.join(tempDir, 'test.db');
  return composeRoot({
    repoRoot: tempDir,
    scriptPath: '/dev/null',
    dbPath,
    repoFullName: 'owner/repo',
    runStartupSweeps: false,
  });
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runs-recovery-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('Recovery REST Endpoints', () => {
  it('invalid UUID returns 400 for all three endpoints', async () => {
    const tempDir = createTempDir();
    const c = compose(tempDir);
    const app = await buildServer(c);

    for (const action of ['cancel', 'retry', 'resume']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/runs/not-a-uuid/${action}`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_id' });
    }
  });

  it('unknown valid UUID returns 404', async () => {
    const tempDir = createTempDir();
    const c = compose(tempDir);
    const app = await buildServer(c);
    const uuid = '00000000-0000-0000-0000-0000000000aa';

    for (const action of ['cancel', 'retry', 'resume']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/${action}`,
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }
  });

  it('invalid body types return 400', async () => {
    const tempDir = createTempDir();
    const c = compose(tempDir);
    const app = await buildServer(c);
    const uuid = '00000000-0000-0000-0000-0000000000bb';

    c.runRepository.insertIfNoActive({
      uuid,
      displayId: 'run-bb',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 11,
      type: 'issue',
      status: 'failed',
      completedPhases: [],
      skippedPhases: [],
      startedAt: new Date(),
    } as unknown as import('@ai-sdlc/domain').Run);

    // Cancel body validation
    {
      const res1 = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/cancel`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify('not-an-object'),
      });
      expect(res1.statusCode).toBe(400);

      const res2 = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/cancel`,
        payload: { reason: 123 },
      });
      expect(res2.statusCode).toBe(400);
    }

    // Retry body validation
    {
      const res1 = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/retry`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify('not-an-object'),
      });
      expect(res1.statusCode).toBe(400);

      const res2 = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/retry`,
        payload: { confirm: 'yes' },
      });
      expect(res2.statusCode).toBe(400);
    }

    // Resume body validation
    {
      const res1 = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/resume`,
        payload: { fromPhase: 123 },
      });
      expect(res1.statusCode).toBe(400);

      const res2 = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/resume`,
        payload: { confirm: 'yes' },
      });
      expect(res2.statusCode).toBe(400);
    }
  });

  it('cancel active Run returns 200 and cancelled state', async () => {
    const tempDir = createTempDir();
    const c = compose(tempDir);
    const app = await buildServer(c);
    const uuid = '00000000-0000-0000-0000-0000000000cc';

    c.runRepository.insertIfNoActive({
      uuid,
      displayId: 'run-cc',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 12,
      type: 'issue',
      status: 'running',
      completedPhases: [],
      skippedPhases: [],
      startedAt: new Date(),
    } as unknown as import('@ai-sdlc/domain').Run);

    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${uuid}/cancel`,
      payload: { reason: 'Test cancel reason' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.action).toBe('cancel');
    expect(body.run.status).toBe('cancelled');

    const refetched = c.runRepository.findByUuid(uuid);
    expect(refetched?.status).toBe('cancelled');
  });

  it('cancel terminal Run returns 409', async () => {
    const tempDir = createTempDir();
    const c = compose(tempDir);
    const app = await buildServer(c);
    const uuid = '00000000-0000-0000-0000-0000000000dd';

    c.runRepository.insertIfNoActive({
      uuid,
      displayId: 'run-dd',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 13,
      type: 'issue',
      status: 'passed',
      completedPhases: [],
      skippedPhases: [],
      startedAt: new Date(),
      completedAt: new Date(),
    } as unknown as import('@ai-sdlc/domain').Run);

    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${uuid}/cancel`,
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('denied');
  });

  it('retry safe phase queues without confirmation', async () => {
    const tempDir = createTempDir();
    const c = compose(tempDir);
    const app = await buildServer(c);
    const uuid = '00000000-0000-0000-0000-0000000000ee';

    c.runRepository.insertIfNoActive({
      uuid,
      displayId: 'run-ee',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 14,
      type: 'issue',
      status: 'failed',
      currentPhase: 'validate',
      completedPhases: [],
      skippedPhases: [],
      startedAt: new Date(),
    } as unknown as import('@ai-sdlc/domain').Run);

    c.phaseRepository.insert({
      id: `${uuid}-validate`,
      runUuid: uuid,
      name: 'validate',
      status: 'failed',
      attempt: 1,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${uuid}/retry`,
      payload: {},
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.action).toBe('retry');
    expect(body.targetPhase).toBe('validate');
    expect(body.requiresConfirmation).toBe(false);
    expect(body.job).toBeDefined();
    expect(body.job.status).toBe('queued');
  });

  it('retry unsafe phase without confirm returns 409 confirmation_required', async () => {
    const tempDir = createTempDir();
    const c = compose(tempDir);
    const app = await buildServer(c);
    const uuid = '00000000-0000-0000-0000-0000000000ff';

    c.runRepository.insertIfNoActive({
      uuid,
      displayId: 'run-ff',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 15,
      type: 'issue',
      status: 'failed',
      currentPhase: 'create-pr',
      completedPhases: [],
      skippedPhases: [],
      startedAt: new Date(),
    } as unknown as import('@ai-sdlc/domain').Run);

    c.phaseRepository.insert({
      id: `${uuid}-create-pr`,
      runUuid: uuid,
      name: 'create-pr',
      status: 'failed',
      attempt: 1,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${uuid}/retry`,
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'confirmation_required',
      requiresConfirmation: true,
      action: 'retry',
      targetPhase: 'create-pr',
      retrySafety: 'unsafe',
      message: 'Retrying this phase can duplicate side effects. Confirm to continue.',
    });
  });

  it('retry unsafe phase with confirm: true queues and returns a queued job', async () => {
    const tempDir = createTempDir();
    const c = compose(tempDir);
    const app = await buildServer(c);
    const uuid = '00000000-0000-0000-0000-000000000100';

    c.runRepository.insertIfNoActive({
      uuid,
      displayId: 'run-100',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 16,
      type: 'issue',
      status: 'failed',
      currentPhase: 'create-pr',
      completedPhases: [],
      skippedPhases: [],
      startedAt: new Date(),
    } as unknown as import('@ai-sdlc/domain').Run);

    c.phaseRepository.insert({
      id: `${uuid}-create-pr`,
      runUuid: uuid,
      name: 'create-pr',
      status: 'failed',
      attempt: 1,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${uuid}/retry`,
      payload: { confirm: true },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.action).toBe('retry');
    expect(body.targetPhase).toBe('create-pr');
    expect(body.requiresConfirmation).toBe(false);
    expect(body.job).toBeDefined();
    expect(body.job.status).toBe('queued');
  });

  it('resume without fromPhase queues default target', async () => {
    const tempDir = createTempDir();
    const c = compose(tempDir);
    const app = await buildServer(c);
    const uuid = '00000000-0000-0000-0000-000000000101';

    c.runRepository.insertIfNoActive({
      uuid,
      displayId: 'run-101',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 17,
      type: 'issue',
      status: 'failed',
      completedPhases: ['read_issue'],
      skippedPhases: [],
      startedAt: new Date(),
    } as unknown as import('@ai-sdlc/domain').Run);

    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${uuid}/resume`,
      payload: {},
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.action).toBe('resume');
    expect(body.targetPhase).toBe('plan-design');
    expect(body.job).toBeDefined();
    expect(body.job.status).toBe('queued');
  });

  it('resume blocked run without fromPhase queues default target', async () => {
    const tempDir = createTempDir();
    const c = compose(tempDir);
    const app = await buildServer(c);
    const uuid = '00000000-0000-0000-0000-000000000104';

    c.runRepository.insertIfNoActive({
      uuid,
      displayId: 'run-104',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 20,
      type: 'issue',
      status: 'blocked',
      completedPhases: ['read_issue'],
      skippedPhases: [],
      startedAt: new Date(),
    } as unknown as import('@ai-sdlc/domain').Run);

    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${uuid}/resume`,
      payload: {},
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.action).toBe('resume');
    expect(body.targetPhase).toBe('plan-design');
    expect(body.job).toBeDefined();
    expect(body.job.status).toBe('queued');
  });

  it('resume with unknown fromPhase returns 400', async () => {
    const tempDir = createTempDir();
    const c = compose(tempDir);
    const app = await buildServer(c);
    const uuid = '00000000-0000-0000-0000-000000000102';

    c.runRepository.insertIfNoActive({
      uuid,
      displayId: 'run-102',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 18,
      type: 'issue',
      status: 'failed',
      completedPhases: [],
      skippedPhases: [],
      startedAt: new Date(),
    } as unknown as import('@ai-sdlc/domain').Run);

    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${uuid}/resume`,
      payload: { fromPhase: 'invalid-phase-name' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unknown_phase');
  });

  it('resume with unsafe fromPhase follows the same confirmation flow', async () => {
    const tempDir = createTempDir();
    const c = compose(tempDir);
    const app = await buildServer(c);
    const uuid = '00000000-0000-0000-0000-000000000103';

    c.runRepository.insertIfNoActive({
      uuid,
      displayId: 'run-103',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 19,
      type: 'issue',
      status: 'failed',
      completedPhases: ['read_issue', 'plan-design', 'plan-write'],
      skippedPhases: [],
      startedAt: new Date(),
    } as unknown as import('@ai-sdlc/domain').Run);

    const resUnconfirmed = await app.inject({
      method: 'POST',
      url: `/api/runs/${uuid}/resume`,
      payload: { fromPhase: 'implement' },
    });

    expect(resUnconfirmed.statusCode).toBe(409);
    expect(resUnconfirmed.json()).toEqual({
      error: 'confirmation_required',
      requiresConfirmation: true,
      action: 'resume',
      targetPhase: 'implement',
      retrySafety: 'unsafe',
      message: 'Retrying this phase can duplicate side effects. Confirm to continue.',
    });

    const resConfirmed = await app.inject({
      method: 'POST',
      url: `/api/runs/${uuid}/resume`,
      payload: { fromPhase: 'implement', confirm: true },
    });

    expect(resConfirmed.statusCode).toBe(202);
    const body = resConfirmed.json();
    expect(body.action).toBe('resume');
    expect(body.targetPhase).toBe('implement');
    expect(body.job).toBeDefined();
    expect(body.job.status).toBe('queued');
  });
});

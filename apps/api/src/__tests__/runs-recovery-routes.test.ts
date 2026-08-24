import { describe, expect, it, afterEach } from 'vitest';
import { RepositoryId, RunId } from '@ai-sdlc/domain';
import { composeRoot } from '../compose.js';
import { buildServer } from '../server.js';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const tempDirs: string[] = [];

function compose(tempDir: string) {
  const dbPath = path.join(tempDir, 'test.db');
  return composeRoot({
    repoRoot: tempDir,
    scriptPath: '/dev/null',
    dbPath,
    repoFullName: 'owner/repo',
    runStartupSweeps: false,
    metadataResolver: {
      resolve: (localPath: string) => {
        if (localPath.endsWith('other')) {
          return {
            rootPath: localPath,
            nameWithOwner: 'acme/widgets',
            defaultBranch: 'main',
            remoteUrl: 'git@github.com:acme/widgets.git',
          };
        }
        return {
          rootPath: localPath,
          nameWithOwner: 'owner/repo',
          defaultBranch: 'main',
          remoteUrl: 'git@github.com:owner/repo.git',
        };
      },
    },
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
        headers: { 'x-repository-id': 'owner/repo' },
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
        headers: { 'content-type': 'application/json', 'x-repository-id': 'owner/repo' },
        payload: JSON.stringify('not-an-object'),
      });
      expect(res1.statusCode).toBe(400);

      const res2 = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/cancel`,
        headers: { 'x-repository-id': 'owner/repo' },
        payload: { reason: 123 },
      });
      expect(res2.statusCode).toBe(400);
    }

    // Retry body validation
    {
      const res1 = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/retry`,
        headers: { 'content-type': 'application/json', 'x-repository-id': 'owner/repo' },
        payload: JSON.stringify('not-an-object'),
      });
      expect(res1.statusCode).toBe(400);

      const res2 = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/retry`,
        headers: { 'x-repository-id': 'owner/repo' },
        payload: { confirm: 'yes' },
      });
      expect(res2.statusCode).toBe(400);
    }

    // Resume body validation
    {
      const res1 = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/resume`,
        headers: { 'x-repository-id': 'owner/repo' },
        payload: { fromPhase: 123 },
      });
      expect(res1.statusCode).toBe(400);

      const res2 = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/resume`,
        headers: { 'x-repository-id': 'owner/repo' },
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
      headers: { 'x-repository-id': 'owner/repo' },
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
      headers: { 'x-repository-id': 'owner/repo' },
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
      headers: { 'x-repository-id': 'owner/repo' },
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
      headers: { 'x-repository-id': 'owner/repo' },
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
      headers: { 'x-repository-id': 'owner/repo' },
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
      headers: { 'x-repository-id': 'owner/repo' },
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
      headers: { 'x-repository-id': 'owner/repo' },
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
      headers: { 'x-repository-id': 'owner/repo' },
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
      headers: { 'x-repository-id': 'owner/repo' },
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
      headers: { 'x-repository-id': 'owner/repo' },
      payload: { fromPhase: 'implement', confirm: true },
    });

    expect(resConfirmed.statusCode).toBe(202);
    const body = resConfirmed.json();
    expect(body.action).toBe('resume');
    expect(body.targetPhase).toBe('implement');
    expect(body.job).toBeDefined();
    expect(body.job.status).toBe('queued');
  });

  describe('Resume Disposition Policy', () => {
    it('returns 400 invalid_body for invalid disposition enum value', async () => {
      const tempDir = createTempDir();
      const c = compose(tempDir);
      const app = await buildServer(c);
      const uuid = '00000000-0000-0000-0000-000000000105';

      c.runRepository.insertIfNoActive({
        uuid,
        displayId: 'run-105',
        repoId: RepositoryId('owner/repo'),
        issueNumber: 21,
        type: 'issue',
        status: 'failed',
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      } as unknown as import('@ai-sdlc/domain').Run);

      const res = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/resume`,
        headers: { 'x-repository-id': 'owner/repo' },
        payload: { disposition: 'invalid_mode' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_body');
    });

    it('returns 409 resume_disposition_required when dirty needs_human_review run omits disposition and causes no mutations', async () => {
      const tempDir = createTempDir();
      const c = compose(tempDir);
      const app = await buildServer(c);
      const uuid = '00000000-0000-0000-0000-000000000106';
      const issueNumber = 22;

      // Create dirty worktree
      const wtDir = path.join(tempDir, '.ai-worktrees', `issue-${issueNumber}`);
      mkdirSync(wtDir, { recursive: true });
      execSync('git init', { cwd: wtDir });
      execSync('git config user.name "Test"', { cwd: wtDir });
      execSync('git config user.email "test@test.com"', { cwd: wtDir });
      writeFileSync(path.join(wtDir, 'file.txt'), 'initial');
      execSync('git add . && git commit -m "initial"', { cwd: wtDir });
      writeFileSync(path.join(wtDir, 'dirty.txt'), 'dirty uncommitted');

      c.runRepository.insertIfNoActive({
        uuid,
        displayId: 'run-106',
        repoId: RepositoryId('owner/repo'),
        issueNumber,
        type: 'issue',
        status: 'needs_human_review',
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      } as unknown as import('@ai-sdlc/domain').Run);

      const res = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/resume`,
        headers: { 'x-repository-id': 'owner/repo' },
        payload: {},
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toBe('resume_disposition_required');
      expect(body.allowed).toEqual(['preserve_working_tree', 'reset_to_baseline']);

      // Assert no run mutation occurred
      const runAfter = c.runRepository.findByUuid(uuid);
      expect(runAfter?.status).toBe('needs_human_review');
      expect(c.jobQueue.listForRun(RunId(uuid))).toHaveLength(0);
    });

    it('accepts explicit preserve_working_tree disposition for dirty human review', async () => {
      const tempDir = createTempDir();
      const c = compose(tempDir);
      const app = await buildServer(c);
      const uuid = '00000000-0000-0000-0000-000000000107';
      const issueNumber = 23;

      const wtDir = path.join(tempDir, '.ai-worktrees', `issue-${issueNumber}`);
      mkdirSync(wtDir, { recursive: true });
      execSync('git init', { cwd: wtDir });
      execSync('git config user.name "Test"', { cwd: wtDir });
      execSync('git config user.email "test@test.com"', { cwd: wtDir });
      writeFileSync(path.join(wtDir, 'file.txt'), 'initial');
      execSync('git add . && git commit -m "initial"', { cwd: wtDir });
      writeFileSync(path.join(wtDir, 'dirty.txt'), 'dirty uncommitted');

      c.runRepository.insertIfNoActive({
        uuid,
        displayId: 'run-107',
        repoId: RepositoryId('owner/repo'),
        issueNumber,
        type: 'issue',
        status: 'needs_human_review',
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      } as unknown as import('@ai-sdlc/domain').Run);

      const res = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/resume`,
        headers: { 'x-repository-id': 'owner/repo' },
        payload: { disposition: 'preserve_working_tree' },
      });

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.job).toBeDefined();
      expect(body.job.resumeDisposition).toBe('preserve_working_tree');
    });

    it('accepts explicit reset_to_baseline disposition for dirty human review', async () => {
      const tempDir = createTempDir();
      const c = compose(tempDir);
      const app = await buildServer(c);
      const uuid = '00000000-0000-0000-0000-000000000108';
      const issueNumber = 24;

      const wtDir = path.join(tempDir, '.ai-worktrees', `issue-${issueNumber}`);
      mkdirSync(wtDir, { recursive: true });
      execSync('git init', { cwd: wtDir });
      execSync('git config user.name "Test"', { cwd: wtDir });
      execSync('git config user.email "test@test.com"', { cwd: wtDir });
      writeFileSync(path.join(wtDir, 'file.txt'), 'initial');
      execSync('git add . && git commit -m "initial"', { cwd: wtDir });
      writeFileSync(path.join(wtDir, 'dirty.txt'), 'dirty uncommitted');

      c.runRepository.insertIfNoActive({
        uuid,
        displayId: 'run-108',
        repoId: RepositoryId('owner/repo'),
        issueNumber,
        type: 'issue',
        status: 'needs_human_review',
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      } as unknown as import('@ai-sdlc/domain').Run);

      const res = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/resume`,
        headers: { 'x-repository-id': 'owner/repo' },
        payload: { disposition: 'reset_to_baseline' },
      });

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.job).toBeDefined();
      expect(body.job.resumeDisposition).toBe('reset_to_baseline');
    });

    it('defaults ordinary failed and cancelled resumes to reset_to_baseline', async () => {
      const tempDir = createTempDir();
      const c = compose(tempDir);
      const app = await buildServer(c);

      // Failed run resume
      const failedUuid = '00000000-0000-0000-0000-000000000109';
      c.runRepository.insertIfNoActive({
        uuid: failedUuid,
        displayId: 'run-109',
        repoId: RepositoryId('owner/repo'),
        issueNumber: 25,
        type: 'issue',
        status: 'failed',
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      } as unknown as import('@ai-sdlc/domain').Run);

      const resFailed = await app.inject({
        method: 'POST',
        url: `/api/runs/${failedUuid}/resume`,
        headers: { 'x-repository-id': 'owner/repo' },
        payload: {},
      });

      expect(resFailed.statusCode).toBe(202);
      expect(resFailed.json().job.resumeDisposition).toBe('reset_to_baseline');

      // Cancelled run resume
      const cancelledUuid = '00000000-0000-0000-0000-000000000110';
      c.runRepository.insertIfNoActive({
        uuid: cancelledUuid,
        displayId: 'run-110',
        repoId: RepositoryId('owner/repo'),
        issueNumber: 26,
        type: 'issue',
        status: 'cancelled',
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      } as unknown as import('@ai-sdlc/domain').Run);

      const resCancelled = await app.inject({
        method: 'POST',
        url: `/api/runs/${cancelledUuid}/resume`,
        headers: { 'x-repository-id': 'owner/repo' },
        payload: {},
      });

      expect(resCancelled.statusCode).toBe(202);
      expect(resCancelled.json().job.resumeDisposition).toBe('reset_to_baseline');
    });

    it('defaults retry to reset_to_baseline', async () => {
      const tempDir = createTempDir();
      const c = compose(tempDir);
      const app = await buildServer(c);
      const uuid = '00000000-0000-0000-0000-000000000111';

      c.runRepository.insertIfNoActive({
        uuid,
        displayId: 'run-111',
        repoId: RepositoryId('owner/repo'),
        issueNumber: 27,
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
        headers: { 'x-repository-id': 'owner/repo' },
        payload: {},
      });

      expect(res.statusCode).toBe(202);
      expect(res.json().job.resumeDisposition).toBe('reset_to_baseline');
    });

    it('rejects omitted disposition for dirty needs_human_review retry with 409 and causes no mutations', async () => {
      const tempDir = createTempDir();
      const c = compose(tempDir);
      const app = await buildServer(c);
      const uuid = '00000000-0000-0000-0000-000000000112';
      const issueNumber = 28;

      const wtDir = path.join(tempDir, '.ai-worktrees', `issue-${issueNumber}`);
      mkdirSync(wtDir, { recursive: true });
      execSync('git init', { cwd: wtDir });
      execSync('git config user.name "Test"', { cwd: wtDir });
      execSync('git config user.email "test@test.com"', { cwd: wtDir });
      writeFileSync(path.join(wtDir, 'file.txt'), 'initial');
      execSync('git add . && git commit -m "initial"', { cwd: wtDir });
      writeFileSync(path.join(wtDir, 'dirty.txt'), 'dirty uncommitted');

      c.runRepository.insertIfNoActive({
        uuid,
        displayId: 'run-112',
        repoId: RepositoryId('owner/repo'),
        issueNumber,
        type: 'issue',
        status: 'needs_human_review',
        currentPhase: 'validate',
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      } as unknown as import('@ai-sdlc/domain').Run);

      c.phaseRepository.insert({
        id: `${uuid}-validate`,
        runUuid: uuid,
        name: 'validate',
        status: 'needs_human_review',
        attempt: 1,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/retry`,
        headers: { 'x-repository-id': 'owner/repo' },
        payload: {},
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toBe('resume_disposition_required');
      expect(body.allowed).toEqual(['preserve_working_tree', 'reset_to_baseline']);

      // Assert no run mutation occurred
      const runAfter = c.runRepository.findByUuid(uuid);
      expect(runAfter?.status).toBe('needs_human_review');
      expect(c.jobQueue.listForRun(RunId(uuid))).toHaveLength(0);
    });

    it('accepts explicit preserve_working_tree disposition for dirty human review retry', async () => {
      const tempDir = createTempDir();
      const c = compose(tempDir);
      const app = await buildServer(c);
      const uuid = '00000000-0000-0000-0000-000000000113';
      const issueNumber = 29;

      const wtDir = path.join(tempDir, '.ai-worktrees', `issue-${issueNumber}`);
      mkdirSync(wtDir, { recursive: true });
      execSync('git init', { cwd: wtDir });
      execSync('git config user.name "Test"', { cwd: wtDir });
      execSync('git config user.email "test@test.com"', { cwd: wtDir });
      writeFileSync(path.join(wtDir, 'file.txt'), 'initial');
      execSync('git add . && git commit -m "initial"', { cwd: wtDir });
      writeFileSync(path.join(wtDir, 'dirty.txt'), 'dirty uncommitted');

      c.runRepository.insertIfNoActive({
        uuid,
        displayId: 'run-113',
        repoId: RepositoryId('owner/repo'),
        issueNumber,
        type: 'issue',
        status: 'needs_human_review',
        currentPhase: 'validate',
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      } as unknown as import('@ai-sdlc/domain').Run);

      c.phaseRepository.insert({
        id: `${uuid}-validate`,
        runUuid: uuid,
        name: 'validate',
        status: 'needs_human_review',
        attempt: 1,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/retry`,
        headers: { 'x-repository-id': 'owner/repo' },
        payload: { disposition: 'preserve_working_tree' },
      });

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.job).toBeDefined();
      expect(body.job.resumeDisposition).toBe('preserve_working_tree');
    });

    it('returns 400 for invalid disposition on retry', async () => {
      const tempDir = createTempDir();
      const c = compose(tempDir);
      const app = await buildServer(c);
      const uuid = '00000000-0000-0000-0000-000000000114';

      c.runRepository.insertIfNoActive({
        uuid,
        displayId: 'run-114',
        repoId: RepositoryId('owner/repo'),
        issueNumber: 30,
        type: 'issue',
        status: 'failed',
        currentPhase: 'validate',
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      } as unknown as import('@ai-sdlc/domain').Run);

      const res = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/retry`,
        headers: { 'x-repository-id': 'owner/repo' },
        payload: { disposition: 'invalid_mode' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_body');
    });
  });

  describe('Strict Context Mismatch Tests', () => {
    it('returns 409 when repository context is missing', async () => {
      const tempDir = createTempDir();
      const c = compose(tempDir);
      const app = await buildServer(c);
      const uuid = '00000000-0000-0000-0000-000000000999';

      c.runRepository.insertIfNoActive({
        uuid,
        displayId: 'run-999',
        repoId: RepositoryId('owner/repo'),
        issueNumber: 19,
        type: 'issue',
        status: 'failed',
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      } as unknown as import('@ai-sdlc/domain').Run);

      const res = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/cancel`,
        payload: {},
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('repository_missing');
    });

    it('returns 404 when repository context is mismatched', async () => {
      const tempDir = createTempDir();
      const c = compose(tempDir);
      const app = await buildServer(c);
      const uuid = '00000000-0000-0000-0000-000000000999';

      c.runRepository.insertIfNoActive({
        uuid,
        displayId: 'run-999',
        repoId: RepositoryId('owner/repo'),
        issueNumber: 19,
        type: 'issue',
        status: 'failed',
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      } as unknown as import('@ai-sdlc/domain').Run);

      // Register another repo to use as mismatched context
      const otherPath = path.join(tempDir, 'other');
      mkdirSync(otherPath);
      execSync('git init', { cwd: otherPath });
      execSync('git remote add origin git@github.com:acme/widgets.git', { cwd: otherPath });
      c.registerRepository.execute({ localPath: otherPath });

      const res = await app.inject({
        method: 'POST',
        url: `/api/runs/${uuid}/cancel`,
        headers: { 'x-repository-id': 'acme/widgets' },
        payload: {},
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('not_found');
    });
  });

  describe('POST /api/runs', () => {
    it('creates a run successfully with canonical lookup', async () => {
      const tempDir = createTempDir();
      const c = compose(tempDir);
      const app = await buildServer(c);

      const res = await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: {
          issueNumber: 42,
          repo: 'owner/repo',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.run).toBeDefined();
      expect(body.run.repoId).toBe('owner/repo');
    });

    it('returns 400 for invalid issue number', async () => {
      const tempDir = createTempDir();
      const c = compose(tempDir);
      const app = await buildServer(c);

      const res = await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: {
          issueNumber: -1,
          repo: 'owner/repo',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_issue_number');
    });
  });
});

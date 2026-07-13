import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RepositoryId, WorkerId, createWorker } from '@ai-sdlc/domain';
import { openDatabase, applyMigrations } from '../../index.js';
import { WorkerRegistryRepository } from '../worker-registry-repository.js';

const REPO_ID = RepositoryId('r1');

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-wrr-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return new WorkerRegistryRepository(db);
}

const now0 = new Date('2026-01-01T00:00:00Z');

describe('WorkerRegistryRepository', () => {
  it('register then findById returns the worker', () => {
    const repo = freshRepo();
    const w = createWorker({
      id: WorkerId('w1'),
      repoId: REPO_ID,
      hostname: 'h1',
      processId: 42,
      now: now0,
    });
    repo.register(w);
    const found = repo.findById(WorkerId('w1'), REPO_ID);
    expect(found?.id).toBe('w1');
    expect(found?.repoId).toBe(REPO_ID);
    expect(found?.hostname).toBe('h1');
    expect(found?.processId).toBe(42);
    expect(found?.status).toBe('idle');
    expect(found?.heartbeatAt).toEqual(now0);
  });

  it('register with same id replaces existing entry (INSERT OR REPLACE)', () => {
    const repo = freshRepo();
    const w1 = createWorker({
      id: WorkerId('w1'),
      repoId: REPO_ID,
      hostname: 'h1',
      processId: 1,
      now: now0,
    });
    repo.register(w1);
    const w2 = createWorker({
      id: WorkerId('w1'),
      repoId: REPO_ID,
      hostname: 'h2',
      processId: 2,
      now: now0,
    });
    repo.register(w2);
    expect(repo.findById(WorkerId('w1'), REPO_ID)?.hostname).toBe('h2');
  });

  it('findById returns undefined for unknown worker', () => {
    const repo = freshRepo();
    expect(repo.findById(WorkerId('ghost'), REPO_ID)).toBeUndefined();
  });

  it('list returns all registered workers', () => {
    const repo = freshRepo();
    repo.register(
      createWorker({
        id: WorkerId('w1'),
        repoId: REPO_ID,
        hostname: 'h1',
        processId: 1,
        now: now0,
      }),
    );
    repo.register(
      createWorker({
        id: WorkerId('w2'),
        repoId: REPO_ID,
        hostname: 'h2',
        processId: 2,
        now: now0,
      }),
    );
    expect(repo.list().map((w) => w.id)).toEqual(expect.arrayContaining(['w1', 'w2']));
  });

  it('heartbeat updates heartbeat_at', () => {
    const repo = freshRepo();
    repo.register(
      createWorker({
        id: WorkerId('w1'),
        repoId: REPO_ID,
        hostname: 'h1',
        processId: 1,
        now: now0,
      }),
    );
    const later = new Date('2026-01-01T01:00:00Z');
    repo.heartbeat(WorkerId('w1'), REPO_ID, later);
    expect(repo.findById(WorkerId('w1'), REPO_ID)?.heartbeatAt).toEqual(later);
  });

  it('markBusy sets status to busy', () => {
    const repo = freshRepo();
    repo.register(
      createWorker({
        id: WorkerId('w1'),
        repoId: REPO_ID,
        hostname: 'h1',
        processId: 1,
        now: now0,
      }),
    );
    repo.markBusy(WorkerId('w1'), REPO_ID);
    expect(repo.findById(WorkerId('w1'), REPO_ID)?.status).toBe('busy');
  });

  it('markIdle sets status to idle from busy', () => {
    const repo = freshRepo();
    repo.register(
      createWorker({
        id: WorkerId('w1'),
        repoId: REPO_ID,
        hostname: 'h1',
        processId: 1,
        now: now0,
      }),
    );
    repo.markBusy(WorkerId('w1'), REPO_ID);
    repo.markIdle(WorkerId('w1'), REPO_ID);
    expect(repo.findById(WorkerId('w1'), REPO_ID)?.status).toBe('idle');
  });

  it('markIdle is a no-op when status is stopping or unhealthy', () => {
    const repo = freshRepo();
    repo.register(
      createWorker({
        id: WorkerId('w1'),
        repoId: REPO_ID,
        hostname: 'h1',
        processId: 1,
        now: now0,
      }),
    );
    repo.markStopping(WorkerId('w1'), REPO_ID);
    repo.markIdle(WorkerId('w1'), REPO_ID);
    expect(repo.findById(WorkerId('w1'), REPO_ID)?.status).toBe('stopping');
  });

  it('markStopping sets status to stopping', () => {
    const repo = freshRepo();
    repo.register(
      createWorker({
        id: WorkerId('w1'),
        repoId: REPO_ID,
        hostname: 'h1',
        processId: 1,
        now: now0,
      }),
    );
    repo.markStopping(WorkerId('w1'), REPO_ID);
    expect(repo.findById(WorkerId('w1'), REPO_ID)?.status).toBe('stopping');
  });

  it('markUnhealthy sets status to unhealthy', () => {
    const repo = freshRepo();
    repo.register(
      createWorker({
        id: WorkerId('w1'),
        repoId: REPO_ID,
        hostname: 'h1',
        processId: 1,
        now: now0,
      }),
    );
    repo.markUnhealthy(WorkerId('w1'), REPO_ID);
    expect(repo.findById(WorkerId('w1'), REPO_ID)?.status).toBe('unhealthy');
  });

  it('throws on mark* for unknown worker', () => {
    const repo = freshRepo();
    expect(() => repo.markBusy(WorkerId('ghost'), REPO_ID)).toThrow(/unknown worker/);
  });

  it('re-registering with same id updates the row in place (ON CONFLICT semantics)', () => {
    const repo = freshRepo();
    const w1 = createWorker({
      id: WorkerId('w1'),
      repoId: REPO_ID,
      hostname: 'h1',
      processId: 1,
      now: now0,
    });
    repo.register(w1);
    const w2 = createWorker({
      id: WorkerId('w1'),
      repoId: REPO_ID,
      hostname: 'h2',
      processId: 2,
      now: now0,
    });
    repo.register(w2);
    expect(repo.list()).toHaveLength(1);
    expect(repo.findById(WorkerId('w1'), REPO_ID)?.hostname).toBe('h2');
    expect(repo.findById(WorkerId('w1'), REPO_ID)?.processId).toBe(2);
  });

  it('heartbeat throws on unknown worker', () => {
    const repo = freshRepo();
    expect(() => repo.heartbeat(WorkerId('ghost'), REPO_ID, new Date())).toThrow(/unknown worker/);
  });

  it('findById throws on corrupted status row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-wrr-bad-'));
    const db = openDatabase(join(dir, 'orch.sqlite'));
    applyMigrations(db);
    db.prepare(
      `INSERT INTO workers (id, repo_id, hostname, process_id, status, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('w1', REPO_ID, 'h1', 1, 'unknown-status-value', now0.toISOString());
    const repo = new WorkerRegistryRepository(db);
    expect(() => repo.findById(WorkerId('w1'), REPO_ID)).toThrow(/unknown worker status/);
    db.close();
  });
});

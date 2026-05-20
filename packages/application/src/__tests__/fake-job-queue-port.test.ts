import { describe, expect, it } from 'vitest';
import { createJob, JobId, RepositoryId, RunId, WorkerId, IssueNumber } from '@ai-sdlc/domain';
import { FakeRepositoryPort, FakeJobQueuePort } from '../test-doubles/index.js';

function repo(id: string, enabled = true) {
  return {
    id: RepositoryId(id),
    owner: 'o',
    name: id,
    fullName: `o/${id}`,
    defaultBranch: 'main',
    localBasePath: `/x/${id}`,
    enabled,
    maxConcurrentRuns: 1 as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function job(id: string, repoId: string, opts: { priority?: number; createdAt?: Date } = {}) {
  return createJob({
    id: JobId(id),
    runId: RunId(`run-${id}`),
    repoId: RepositoryId(repoId),
    issueNumber: IssueNumber(1),
    priority: opts.priority,
    createdAt: opts.createdAt ?? new Date(),
  });
}

describe('FakeJobQueuePort', () => {
  it('enqueue rejects an unknown repo', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([]));
    expect(() => q.enqueue({ job: job('j1', 'unknown') })).toThrow(/not approved/);
  });
  it('enqueue rejects a disabled repo', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1', false)]));
    expect(() => q.enqueue({ job: job('j1', 'r1') })).toThrow(/not approved/);
  });
  it('claimNext returns the highest-priority oldest queued job', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1')]));
    q.enqueue({ job: job('a', 'r1', { priority: 0, createdAt: new Date('2026-01-01') }) });
    q.enqueue({ job: job('b', 'r1', { priority: 5, createdAt: new Date('2026-01-02') }) });
    q.enqueue({ job: job('c', 'r1', { priority: 5, createdAt: new Date('2026-01-01') }) });
    const claimed = q.claimNext({ workerId: WorkerId('w1') });
    expect(claimed?.id).toBe('c');
  });
  it('claimNext on second attempt returns next job (no double-claim)', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1')]));
    q.enqueue({ job: job('a', 'r1') });
    q.enqueue({ job: job('b', 'r1', { createdAt: new Date(Date.now() + 1000) }) });
    expect(q.claimNext({ workerId: WorkerId('w1') })?.id).toBe('a');
    expect(q.claimNext({ workerId: WorkerId('w2') })?.id).toBe('b');
  });
  it('claimNext returns undefined when nothing is queued', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1')]));
    expect(q.claimNext({ workerId: WorkerId('w1') })).toBeUndefined();
  });
  it('lifecycle: claim -> markRunning -> markSucceeded', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1')]));
    q.enqueue({ job: job('a', 'r1') });
    const c = q.claimNext({ workerId: WorkerId('w1') })!;
    q.markRunning(c.id, new Date());
    q.markSucceeded(c.id, new Date());
    expect(q.findById(c.id)?.status).toBe('succeeded');
  });
  it('listForRepo / listForRun return matching jobs', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1'), repo('r2')]));
    q.enqueue({ job: job('a', 'r1') });
    q.enqueue({ job: job('b', 'r2') });
    expect(q.listForRepo(RepositoryId('r1')).map((j) => j.id)).toEqual(['a']);
    expect(q.listForRun(RunId('run-a')).map((j) => j.id)).toEqual(['a']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  createJob,
  JobId,
  RepositoryId,
  RunId,
  WorkerId,
  IssueNumber,
  generateJobOwnership,
  JobOwnershipLostError,
} from '@ai-sdlc/domain';
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
    const claimed = q.claimNext({ workerId: WorkerId('w1'), repoId: RepositoryId('r1') });
    expect(claimed?.id).toBe('c');
  });
  it('claimNext on second attempt returns next job (no double-claim)', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1')]));
    q.enqueue({ job: job('a', 'r1', { createdAt: new Date('2026-01-01T00:00:00Z') }) });
    q.enqueue({ job: job('b', 'r1', { createdAt: new Date('2026-01-01T00:00:01Z') }) });
    expect(q.claimNext({ workerId: WorkerId('w1'), repoId: RepositoryId('r1') })?.id).toBe('a');
    expect(q.claimNext({ workerId: WorkerId('w2'), repoId: RepositoryId('r1') })?.id).toBe('b');
  });
  it('claimNext returns undefined when nothing is queued', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1')]));
    expect(q.claimNext({ workerId: WorkerId('w1'), repoId: RepositoryId('r1') })).toBeUndefined();
  });
  it('lifecycle: claim -> markRunning -> markSucceeded', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1')]));
    q.enqueue({ job: job('a', 'r1') });
    const c = q.claimNext({ workerId: WorkerId('w1'), repoId: RepositoryId('r1') })!;
    const ownership = generateJobOwnership(c, WorkerId('w1'));
    q.markRunning(ownership, new Date());
    q.markSucceeded(ownership, new Date());
    expect(q.findById(c.id)?.status).toBe('succeeded');
  });
  it('lifecycle: claim -> markRunning -> markFailed', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1')]));
    q.enqueue({ job: job('a', 'r1') });
    const c = q.claimNext({ workerId: WorkerId('w1'), repoId: RepositoryId('r1') })!;
    const ownership = generateJobOwnership(c, WorkerId('w1'));
    q.markRunning(ownership, new Date());
    q.markFailed(ownership, new Date());
    expect(q.findById(c.id)?.status).toBe('failed');
  });
  it('lifecycle: claim -> markRunning -> markCancelled', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1')]));
    q.enqueue({ job: job('a', 'r1') });
    const c = q.claimNext({ workerId: WorkerId('w1'), repoId: RepositoryId('r1') })!;
    const ownership = generateJobOwnership(c, WorkerId('w1'));
    q.markRunning(ownership, new Date());
    q.markCancelled(ownership, new Date());
    expect(q.findById(c.id)?.status).toBe('cancelled');
  });
  it('listForRepo / listForRun return matching jobs', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1'), repo('r2')]));
    q.enqueue({ job: job('a', 'r1') });
    q.enqueue({ job: job('b', 'r2') });
    expect(q.listForRepo(RepositoryId('r1')).map((j) => j.id)).toEqual(['a']);
    expect(q.listForRun(RunId('run-a')).map((j) => j.id)).toEqual(['a']);
  });

  describe('repository-scoped claimNext', () => {
    it('claim_is_repository_scoped: claimNext only returns queued jobs from the requested repository', () => {
      const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1'), repo('r2')]));
      q.enqueue({ job: job('a', 'r1') });
      q.enqueue({ job: job('b', 'r2') });
      const claimed = q.claimNext({ workerId: WorkerId('w1'), repoId: RepositoryId('r1') });
      expect(claimed?.id).toBe('a');
      expect(claimed?.repoId).toBe('r1');
    });

    it('claim_order_is_local_to_repository: claimNext preserves priority created-at and id order within the requested repository', () => {
      const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1'), repo('r2')]));
      q.enqueue({ job: job('a', 'r1', { priority: 0, createdAt: new Date('2026-01-01') }) });
      q.enqueue({ job: job('b', 'r1', { priority: 5, createdAt: new Date('2026-01-02') }) });
      q.enqueue({ job: job('c', 'r1', { priority: 5, createdAt: new Date('2026-01-01') }) });
      q.enqueue({ job: job('x', 'r2', { priority: 10, createdAt: new Date('2026-01-01') }) });
      const claimed = q.claimNext({ workerId: WorkerId('w1'), repoId: RepositoryId('r1') });
      expect(claimed?.id).toBe('c');
    });

    it('concurrent repository-scoped claims cannot cross repository ids', () => {
      const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1'), repo('r2')]));
      q.enqueue({ job: job('a', 'r1') });
      q.enqueue({ job: job('b', 'r2') });
      const claimedR1 = q.claimNext({ workerId: WorkerId('w1'), repoId: RepositoryId('r1') });
      expect(claimedR1?.repoId).toBe('r1');
      const claimedR2 = q.claimNext({ workerId: WorkerId('w2'), repoId: RepositoryId('r2') });
      expect(claimedR2?.repoId).toBe('r2');
      expect(claimedR1?.id).not.toBe(claimedR2?.id);
    });

    it('stale claim token cannot mutate reclaimed job', () => {
      const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1')]));
      q.enqueue({ job: job('a', 'r1') });

      // 1st claim
      const claimed1 = q.claimNext({ workerId: WorkerId('w1'), repoId: RepositoryId('r1') });
      expect(claimed1).toBeDefined();
      const owner1 = generateJobOwnership(claimed1!, WorkerId('w1'));

      // Reclaim (via releaseClaim) and 2nd claim (gets a fresh token)
      q.releaseClaim(owner1);
      const claimed2 = q.claimNext({ workerId: WorkerId('w2'), repoId: RepositoryId('r1') });
      expect(claimed2).toBeDefined();
      const _owner2 = generateJobOwnership(claimed2!, WorkerId('w2'));

      // Verify owner1 (stale claim token) cannot mutate the reclaimed job:
      // 1. markRunning
      expect(() => q.markRunning(owner1, new Date())).toThrow(JobOwnershipLostError);
      // 2. markSucceeded
      expect(() => q.markSucceeded(owner1, new Date())).toThrow(JobOwnershipLostError);
      // 3. markFailed
      expect(() => q.markFailed(owner1, new Date())).toThrow(JobOwnershipLostError);
      // 4. markCancelled
      expect(() => q.markCancelled(owner1, new Date())).toThrow(JobOwnershipLostError);
      // 5. releaseClaim
      expect(() => q.releaseClaim(owner1)).toThrow(JobOwnershipLostError);
      // 6. resetToQueued
      expect(() => q.resetToQueued(owner1)).toThrow(JobOwnershipLostError);
    });
  });
});

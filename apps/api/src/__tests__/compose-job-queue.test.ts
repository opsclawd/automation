import { describe, expect, it } from 'vitest';
import { composeRoot } from '../compose.js';
import { JobId, RunId, RepositoryId, IssueNumber, WorkerId, createJob } from '@ai-sdlc/domain';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

describe('Compose Job Queue', () => {
  it('composeRoot() exposes jobQueue', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'compose-job-queue-'));
    const dbPath = path.join(tempDir, 'test.db');
    const container = composeRoot({
      repoRoot: tempDir,
      scriptPath: '/dev/null',
      dbPath,
      repoFullName: 'owner/repo',
      runStartupSweeps: false,
    });
    expect(container.jobQueue).toBeDefined();
    expect(typeof container.jobQueue.enqueue).toBe('function');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('enqueue through container.jobQueue persists and can be read by a second composeRoot() using the same dbPath', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'compose-job-queue-'));
    const dbPath = path.join(tempDir, 'test.db');

    // First composeRoot
    const container1 = composeRoot({
      repoRoot: tempDir,
      scriptPath: '/dev/null',
      dbPath,
      repoFullName: 'owner/repo',
      runStartupSweeps: false,
    });

    const job = createJob({
      id: 'job-1' as JobId,
      runId: 'run-1' as RunId,
      repoId: RepositoryId('owner/repo'),
      issueNumber: IssueNumber(1),
      priority: 1,
      createdAt: new Date(),
    });

    container1.jobQueue.enqueue({ job });

    // Second composeRoot
    const container2 = composeRoot({
      repoRoot: tempDir,
      scriptPath: '/dev/null',
      dbPath,
      repoFullName: 'owner/repo',
      runStartupSweeps: false,
    });

    const found = container2.jobQueue.findById('job-1' as JobId);
    expect(found).toBeDefined();
    expect(found?.id).toBe('job-1');
    expect(found?.runId).toBe('run-1');
    expect(found?.repoId).toBe('owner/repo');

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('container.resumeRun.execute() enqueues a readable queued job for a failed Run', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'compose-job-queue-'));
    const dbPath = path.join(tempDir, 'test.db');

    const container = composeRoot({
      repoRoot: tempDir,
      scriptPath: '/dev/null',
      dbPath,
      repoFullName: 'owner/repo',
      runStartupSweeps: false,
    });

    // Seed a failed run
    container.runRepository.insertIfNoActive({
      uuid: 'run-1',
      displayId: 'issue-1-20260601-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'failed',
      completedPhases: [],
      skippedPhases: [],
      startedAt: new Date('2026-06-01T00:00:00Z'),
    } as unknown as import('@ai-sdlc/domain').Run);

    // Call resumeRun.execute()
    const result = await container.resumeRun.execute({
      runId: RunId('run-1'),
      workerId: WorkerId('worker-1'),
    });

    expect(result).toBeDefined();
    expect(result.jobId).toBeDefined();
    expect(result.jobStatus).toBe('queued');

    // Verify the job is queued in the database and readable
    const job = container.jobQueue.findById(result.jobId);
    expect(job).toBeDefined();
    expect(job?.id).toBe(result.jobId);
    expect(job?.runId).toBe('run-1');
    expect(job?.status).toBe('queued');

    rmSync(tempDir, { recursive: true, force: true });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createJob, JobId, RunId, IssueNumber, WorkerId } from '@ai-sdlc/domain';
import { composeRoot } from '../compose.js';
import { RepositorySchedulerAdapter } from '../repository-scheduler-adapter.js';

describe('serve scheduler DB alignment (#1217)', () => {
  let tmpDir: string;
  let targetRepo: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'test-serve-db-align-'));
    targetRepo = join(tmpDir, 'target-repo');
    mkdirSync(targetRepo, { recursive: true });
    execFileSync('git', ['init'], { cwd: targetRepo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: targetRepo });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: targetRepo });
    writeFileSync(join(targetRepo, 'README.md'), '# Target Repo');
    execFileSync('git', ['add', '.'], { cwd: targetRepo });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: targetRepo });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('serve scheduler inspects and claims jobs enqueued into c.jobQueue (single target repo mode)', async () => {
    const repoRoot = resolve(process.cwd());
    const container = composeRoot({
      repoRoot,
      targetRepoRoot: targetRepo,
      dbPath: join(tmpDir, 'test-db-1.sqlite'),
      scriptPath: join(repoRoot, 'scripts/legacy/ai-run-issue-v2'),
      runStartupSweeps: false,
      metadataResolver: {
        resolve: (p) => ({
          rootPath: p,
          nameWithOwner: 'test-owner/target-repo',
          defaultBranch: 'main',
          remoteUrl: 'https://github.com/test-owner/target-repo.git',
        }),
      },
    });

    const repo = container.registerRepository.execute({ localPath: targetRepo });
    const repos = container.listRepositories.execute();
    expect(repos.length).toBe(1);

    // 1. Simulate job admission (e.g. run, resume, or release-batch start)
    const runUuid = '11111111-2222-3333-4444-555555555555';
    const jobId = JobId('job-1217-target');
    const startedAt = new Date();

    container.runRepository.insertIfNoActive({
      uuid: runUuid,
      displayId: 'issue-42-test',
      repoId: repo.id,
      issueNumber: 42,
      type: 'issue_to_pr',
      status: 'queued',
      completedPhases: [],
      skippedPhases: [],
      startedAt,
    });

    const job = createJob({
      id: jobId,
      runId: RunId(runUuid),
      repoId: repo.id,
      issueNumber: IssueNumber(42),
      priority: 0,
      createdAt: startedAt,
    });
    container.jobQueue.enqueue({ job });

    // 2. Build the scheduler adapter using the container's runtime catalog
    let workerLoopCalledWith: { runId: string; workerId: string } | undefined;

    const adapter = new RepositorySchedulerAdapter({
      runtimeFactory: async (r) => {
        return await container.runtimeCatalog.resolve(r.id);
      },
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      workerLoop: async (runtime, input) => {
        workerLoopCalledWith = {
          runId: String(input.runId),
          workerId: String(input.workerId),
        };
        // Verify runtime can see the run in runRepository
        const foundRun = runtime.runRepository.findByUuid(String(input.runId));
        expect(foundRun).toBeDefined();
        expect(foundRun?.uuid).toBe(runUuid);
      },
    });

    // 3. Inspect: Before fix, queueDepth was 0 because scheduler queried .ai-state database!
    const inspection = await adapter.inspect(repo);
    expect(inspection).toEqual({
      available: true,
      queueDepth: 1,
      activeCount: 0,
    });

    // 4. Run one: Claim and execute the job
    const workerId = WorkerId('worker-test-1');
    const outcome = await adapter.runOne({
      repository: repo,
      workerId,
    });

    expect(outcome).toBe('completed');
    expect(workerLoopCalledWith).toEqual({
      runId: runUuid,
      workerId: String(workerId),
    });

    // 5. Job claim in shared database is reflected in container's jobQueue
    const admittedJob = container.jobQueue.findById(jobId);
    expect(admittedJob).toBeDefined();
    expect(admittedJob?.claimedBy).toBe(workerId);
    expect(admittedJob?.status).toBe('claimed');

    adapter.close();
    await container.runtimeCatalog.close();
  });

  it('serve scheduler partitions jobs between multiple registered repositories on shared controlPlaneDb', async () => {
    const repoRoot = resolve(process.cwd());
    const container = composeRoot({
      repoRoot,
      dbPath: join(tmpDir, 'test-db-2.sqlite'),
      scriptPath: join(repoRoot, 'scripts/legacy/ai-run-issue-v2'),
      runStartupSweeps: false,
      metadataResolver: {
        resolve: (p) => ({
          rootPath: p,
          nameWithOwner: `owner/${p.split('/').pop()}`,
          defaultBranch: 'main',
          remoteUrl: `https://github.com/owner/${p.split('/').pop()}.git`,
        }),
      },
    });

    const repoDirA = join(tmpDir, 'repo-a');
    const repoDirB = join(tmpDir, 'repo-b');
    mkdirSync(repoDirA, { recursive: true });
    mkdirSync(repoDirB, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoDirA });
    execFileSync('git', ['init'], { cwd: repoDirB });

    const repoA = container.registerRepository.execute({ localPath: repoDirA });
    const repoB = container.registerRepository.execute({ localPath: repoDirB });

    // Enqueue job only for repo A
    const runUuidA = 'aaaa1111-2222-3333-4444-555555555555';
    const jobIdA = JobId('job-1217-repo-a');
    const startedAt = new Date();

    container.runRepository.insertIfNoActive({
      uuid: runUuidA,
      displayId: 'issue-10-test',
      repoId: repoA.id,
      issueNumber: 10,
      type: 'issue_to_pr',
      status: 'queued',
      completedPhases: [],
      skippedPhases: [],
      startedAt,
    });

    const jobA = createJob({
      id: jobIdA,
      runId: RunId(runUuidA),
      repoId: repoA.id,
      issueNumber: IssueNumber(10),
      priority: 0,
      createdAt: startedAt,
    });
    container.jobQueue.enqueue({ job: jobA });

    const adapter = new RepositorySchedulerAdapter({
      runtimeFactory: async (r) => {
        return await container.runtimeCatalog.resolve(r.id);
      },
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    // Inspect repoA: should have queueDepth 1
    const inspectA = await adapter.inspect(repoA);
    expect(inspectA).toEqual({
      available: true,
      queueDepth: 1,
      activeCount: 0,
    });

    // Inspect repoB: should have queueDepth 0 (isolated)
    const inspectB = await adapter.inspect(repoB);
    expect(inspectB).toEqual({
      available: true,
      queueDepth: 0,
      activeCount: 0,
    });

    adapter.close();
    await container.runtimeCatalog.close();
  });
});

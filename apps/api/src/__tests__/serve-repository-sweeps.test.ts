import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { WorkerId } from '@ai-sdlc/domain';
import { composeRoot } from '../compose.js';

// Task 6 (#652): recovery sweeps must be run per-Repository against each
// Repository's own operational runtime via `buildRepositorySweepCoordinator`,
// rather than a single root-scoped sweep. These tests prove:
//  - each Repository's sweep only ever touches that Repository's own runs
//    (waiting_sweep_enqueues_in_owning_runtime / orphan_sweep_enqueues_in_owning_runtime),
//  - a Repository that cannot be resolved does not prevent the others from
//    being swept (unavailable_runtime_does_not_block_other_sweeps).

const dirs: string[] = [];
function tmpRepoDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ai-orch-sweep-repo-${name}-`));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function buildContainer() {
  const runsDir = join(tmpdir(), `ai-orch-sweep-test-${Math.random()}`);
  return composeRoot({
    repoRoot: process.cwd(),
    scriptPath: '/bin/true',
    dbPath: ':memory:',
    runsDir,
    metadataResolver: {
      resolve: (path: string) => {
        // Reject the compose-root path itself so composeRoot's legacy
        // single-repo fallback (`repoFullName`) never resolves to a repo
        // outside this test's explicitly registered multi-Repository set.
        if (path === process.cwd()) {
          throw new Error('not a registered repository path');
        }
        return {
          rootPath: path,
          nameWithOwner: `owner/${basename(path)}`,
          defaultBranch: 'main',
          remoteUrl: `git@github.com:owner/${basename(path)}.git`,
        };
      },
    },
  });
}

function makeRun(uuid: string, repoId: string, overrides: Record<string, unknown> = {}) {
  return {
    uuid,
    displayId: uuid,
    repoId,
    issueNumber: 1,
    type: 'issue_to_pr',
    status: 'running',
    completedPhases: [],
    skippedPhases: [],
    startedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  } as never;
}

describe('buildRepositorySweepCoordinator (#652 Task 6)', () => {
  it('orphan_sweep_enqueues_in_owning_runtime: recovers an orphaned run only in the Repository it belongs to', async () => {
    const c = buildContainer();
    const repoA = c.registerRepository.execute({ localPath: tmpRepoDir('a') });
    const repoB = c.registerRepository.execute({ localPath: tmpRepoDir('b') });
    const runtimeA = await c.runtimeCatalog.resolve(repoA.id, { allowDisabled: true });
    const runtimeB = await c.runtimeCatalog.resolve(repoB.id, { allowDisabled: true });

    const orphanUuid = '88888888-8888-8888-8888-888888888888';
    // A very large, almost-certainly-unused pid so `checkPid` reports it dead.
    runtimeA.runRepository.insert(makeRun(orphanUuid, repoA.id), 424242);

    const coordinator = c.buildRepositorySweepCoordinator();
    const result = await coordinator.execute(WorkerId('sweep-worker'));

    const entryA = result.results.find((r) => r.repositoryId === String(repoA.id));
    const entryB = result.results.find((r) => r.repositoryId === String(repoB.id));

    expect(entryA?.orphaned?.scanned).toBe(1);
    expect(entryA?.orphaned?.enqueued).toBe(1);
    expect(entryA?.error).toBeUndefined();
    // repo B's runtime never saw repo A's orphaned run.
    expect(entryB?.orphaned?.scanned).toBe(0);
    expect(entryB?.orphaned?.enqueued).toBe(0);

    // A successful orphan recovery atomically transitions failed -> running
    // (resumeRun) once the recovery job is enqueued, handing the run to a
    // fresh worker rather than leaving it terminally failed.
    const updated = runtimeA.runRepository.findByUuid(orphanUuid);
    expect(updated?.status).toBe('running');
    // The recovery job landed in repo A's own queue, not repo B's.
    expect(runtimeA.jobQueue.listActive().length).toBeGreaterThan(0);
    expect(runtimeB.jobQueue.listActive().length).toBe(0);
  });

  it('waiting_sweep_enqueues_in_owning_runtime: scans only the waiting runs belonging to each runtime', async () => {
    const c = buildContainer();
    const repoA = c.registerRepository.execute({ localPath: tmpRepoDir('a') });
    const repoB = c.registerRepository.execute({ localPath: tmpRepoDir('b') });
    const runtimeA = await c.runtimeCatalog.resolve(repoA.id, { allowDisabled: true });
    await c.runtimeCatalog.resolve(repoB.id, { allowDisabled: true });

    const waitingUuid = '99999999-9999-9999-9999-999999999999';
    runtimeA.runRepository.insert(
      makeRun(waitingUuid, repoA.id, { status: 'waiting', completedAt: new Date() }),
    );

    const coordinator = c.buildRepositorySweepCoordinator();
    const result = await coordinator.execute(WorkerId('sweep-worker'));

    const entryA = result.results.find((r) => r.repositoryId === String(repoA.id));
    const entryB = result.results.find((r) => r.repositoryId === String(repoB.id));

    // No pr-url.txt artifact exists, so the PR context cannot resolve and
    // the run is skipped rather than reactivated/errored — but critically
    // it was scanned only by its own runtime, proving per-Repository scope.
    expect(entryA?.waiting?.scanned).toBe(1);
    expect(entryA?.error).toBeUndefined();
    expect(entryB?.waiting?.scanned).toBe(0);
  });

  it('unavailable_runtime_does_not_block_other_sweeps: a Repository that fails to resolve does not stop the others from sweeping', async () => {
    const c = buildContainer();
    const repoA = c.registerRepository.execute({ localPath: tmpRepoDir('a') });
    const repoB = c.registerRepository.execute({ localPath: tmpRepoDir('b') });

    const orphanUuid = '77777777-1111-1111-1111-111111111111';
    const runtimeA = await c.runtimeCatalog.resolve(repoA.id, { allowDisabled: true });
    runtimeA.runRepository.insert(makeRun(orphanUuid, repoA.id), 424242);

    // Make repo B unresolvable going forward.
    c.repositoryRegistry.update(repoB.id, { healthStatus: 'degraded' }, new Date());

    const coordinator = c.buildRepositorySweepCoordinator();
    const result = await coordinator.execute(WorkerId('sweep-worker'));

    // resolveAllOperational returns an entry for every registered repository,
    // even when resolution fails. repo B appears with an error while repo A
    // still gets a full, successful sweep.
    const entryB = result.results.find((r) => r.repositoryId === String(repoB.id));
    expect(entryB).toBeDefined();
    expect(entryB?.error).toBeDefined();
    const entryA = result.results.find((r) => r.repositoryId === String(repoA.id));
    expect(entryA?.orphaned?.enqueued).toBe(1);
    expect(entryA?.error).toBeUndefined();
  });

  it('repository_recovery_failures_are_isolated: one repository sweep failure does not suppress other repositories', async () => {
    const c = buildContainer();
    const repoA = c.registerRepository.execute({ localPath: tmpRepoDir('a') });
    const repoB = c.registerRepository.execute({ localPath: tmpRepoDir('b') });

    const orphanUuid = '66666666-6666-6666-6666-666666666666';
    const runtimeA = await c.runtimeCatalog.resolve(repoA.id, { allowDisabled: true });
    runtimeA.runRepository.insert(makeRun(orphanUuid, repoA.id), 424242);
    // repo B has a valid runtime but no orphaned runs

    const coordinator = c.buildRepositorySweepCoordinator();
    const result = await coordinator.execute(WorkerId('sweep-worker'));

    // Both repos appear in results
    expect(result.results).toHaveLength(2);
    const entryA = result.results.find((r) => r.repositoryId === String(repoA.id));
    const entryB = result.results.find((r) => r.repositoryId === String(repoB.id));
    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();
    // repo A recovered successfully
    expect(entryA?.orphaned?.enqueued).toBe(1);
    expect(entryA?.error).toBeUndefined();
    // repo B scanned zero runs but had no failure
    expect(entryB?.orphaned?.scanned).toBe(0);
    expect(entryB?.error).toBeUndefined();
  });

  it('resolveAllOperational_includes_disabled_repository: disabled repo appears in results but does not reactivate waiting work', async () => {
    const c = buildContainer();
    const repoA = c.registerRepository.execute({ localPath: tmpRepoDir('a') });
    const repoB = c.registerRepository.execute({ localPath: tmpRepoDir('b') });

    const runtimeA = await c.runtimeCatalog.resolve(repoA.id, { allowDisabled: true });
    await c.runtimeCatalog.resolve(repoB.id, { allowDisabled: true });

    // Add a waiting run to both repos
    const waitingUuidA = 'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    runtimeA.runRepository.insert(
      makeRun(waitingUuidA, repoA.id, { status: 'waiting', completedAt: new Date() }),
    );
    const waitingUuidB = 'aaaaaaa2-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const runtimeB = await c.runtimeCatalog.resolve(repoB.id, { allowDisabled: true });
    runtimeB.runRepository.insert(
      makeRun(waitingUuidB, repoB.id, { status: 'waiting', completedAt: new Date() }),
    );

    // Disable repo B
    c.disableRepository.execute(repoB.id);

    const coordinator = c.buildRepositorySweepCoordinator();
    const result = await coordinator.execute(WorkerId('sweep-worker'));

    // Both repos appear in results
    expect(result.results).toHaveLength(2);
    const entryA = result.results.find((r) => r.repositoryId === String(repoA.id));
    const entryB = result.results.find((r) => r.repositoryId === String(repoB.id));
    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();
    // repo A (enabled) scanned its waiting run
    expect(entryA?.waiting?.scanned).toBe(1);
    expect(entryA?.error).toBeUndefined();
    // repo B (disabled) appears but did not reactivate waiting work
    expect(entryB?.waiting?.scanned).toBe(0);
    expect(entryB?.error).toBeUndefined();
  });
});

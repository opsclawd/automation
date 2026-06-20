import { cancelRun } from '@ai-sdlc/domain';
import type { RunId, RepositoryId } from '@ai-sdlc/domain';
import type { RunRepositoryPort, RunAbortPort, GitPort, WorkerLeasePort } from './ports.js';
import type { CancelRunUseCase } from './use-cases.js';

export interface CancelRunDeps {
  runRepository: RunRepositoryPort;
  runAbort: RunAbortPort;
  git: GitPort;
  leases: WorkerLeasePort;
  findCwd: (repoId: RepositoryId, runId: RunId) => string;
  findStartCommitSha: (runId: RunId) => string;
  findRepoId: (runId: RunId) => RepositoryId;
  now?: () => Date;
}

export class CancelRun implements CancelRunUseCase {
  constructor(private readonly deps: CancelRunDeps) {}

  async execute(input: { runId: RunId; reason?: string }): Promise<void> {
    const now = this.deps.now ?? (() => new Date());
    const run = this.deps.runRepository.findByUuid(input.runId);
    if (!run) {
      throw new Error(`No run found for ${input.runId}`);
    }
    const { runAbort, git, leases } = this.deps;

    // Step 1: Validate and transform domain state — MUST happen before side effects
    const cancelled = cancelRun(run, input.reason, now());

    // Step 2: Persist cancelled state (MUST succeed — throws on failure)
    const updated = this.deps.runRepository.updateStatusByUuid(input.runId, {
      status: cancelled.status,
      completedAt:
        cancelled.completedAt ??
        (() => {
          throw new Error('cancelRun did not set completedAt');
        })(),
      ...(cancelled.failureReason ? { failureReason: cancelled.failureReason } : {}),
    });
    if (!updated) {
      throw new Error(`Run ${input.runId} status could not be updated (concurrent modification)`);
    }

    // Step 3: Abort agent (best-effort)
    try {
      runAbort.abort(input.runId);
    } catch (err) {
      console.error(`CancelRun: abort failed for ${input.runId}`, err);
    }
    try {
      runAbort.unregister(input.runId);
    } catch (err) {
      console.error(`CancelRun: unregister failed for ${input.runId}`, err);
    }

    // TODO(#logging-story): Replace console.error with a Logger port once the
    // logging port story is settled. Application layer should use port-injected
    // logger per AGENTS.md layer rules.
    // Step 4-5: Cleanup (best-effort)
    let repoId: RepositoryId | undefined;
    try {
      repoId = this.deps.findRepoId(input.runId);
    } catch {
      // findRepoId not available — skip cleanup steps
    }

    if (repoId !== undefined) {
      // Step 4: Reset worktree (best-effort)
      try {
        const cwd = this.deps.findCwd(repoId, input.runId);
        const startCommitSha = this.deps.findStartCommitSha(input.runId);
        await git.resetHard(cwd, startCommitSha);
      } catch (err) {
        console.error(`CancelRun: worktree reset failed for ${input.runId}`, err);
      }

      // Step 5: Release lease (best-effort)
      try {
        const lease = leases.current(repoId);
        if (lease) {
          if (lease.runId !== input.runId) {
            console.error(
              `CancelRun: lease runId mismatch for repo ${repoId}: expected ${input.runId}, got ${lease.runId}`,
            );
          } else {
            leases.release(repoId, lease.workerId);
          }
        }
      } catch (err) {
        console.error(`CancelRun: lease release failed for ${input.runId}`, err);
      }
    }
  }
}

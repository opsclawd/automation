import { cancelRun, LeaseOwnershipLostError } from '@ai-sdlc/domain';
import type { RunId, RunStatus } from '@ai-sdlc/domain'; // run identification
import type {
  RunRepositoryPort,
  RunAbortPort,
  GitPort,
  WorkerLeasePort,
  LoggerPort,
  ResolveWorktreeCwdFn,
  ResolveStartCommitShaFn,
  AbortResult,
} from './ports.js';
import type { CancelRunUseCase, CancelRunResult } from './use-cases.js';

export interface CancelRunDeps {
  runRepository: RunRepositoryPort;
  runAbort: RunAbortPort;
  git: GitPort;
  leases: WorkerLeasePort;
  findCwd: ResolveWorktreeCwdFn;
  findStartCommitSha: ResolveStartCommitShaFn;
  logger: LoggerPort;
  now?: () => Date;
}

export class CancelRun implements CancelRunUseCase {
  constructor(private readonly deps: CancelRunDeps) {}

  async execute(input: { runId: RunId; reason?: string }): Promise<CancelRunResult> {
    const now = this.deps.now ?? (() => new Date());
    const run = this.deps.runRepository.findByUuid(input.runId);
    if (!run) {
      throw new Error(`No run found for ${input.runId}`);
    }
    const { runAbort, git, leases } = this.deps;

    // Step 1: Validate and transform domain state — MUST happen before side effects
    const cancelled = cancelRun(run, input.reason, now());

    // Step 2: Persist cancelled state (MUST succeed — throws on failure)
    // NOTE: There is a TOCTOU window between the domain validation above and
    // this SQL UPDATE. The DB-level guard (WHERE status NOT IN terminal) and
    // the `!updated` check below catch concurrent terminal transitions.
    const updated = this.deps.runRepository.atomicUpdateByUuid(
      input.runId,
      {
        status: cancelled.status,
        completedAt: cancelled.completedAt!,
        currentPhase: null,
        ...(cancelled.failureReason ? { failureReason: cancelled.failureReason } : {}),
      },
      run.status,
    );
    if (!updated) {
      throw new Error(`Run ${input.runId} status could not be updated (concurrent modification)`);
    }

    // Step 3: Abort agent (best-effort)
    let abortStatus: AbortResult['status'] = 'not_found';
    try {
      const abortRes = await runAbort.abort(input.runId);
      if (abortRes && abortRes.status) {
        abortStatus = abortRes.status;
      } else {
        abortStatus = 'exited';
      }
    } catch (err) {
      this.deps.logger.error(`CancelRun: abort failed for ${input.runId}`, err);
    }
    try {
      runAbort.unregister(input.runId);
    } catch (err) {
      this.deps.logger.error(`CancelRun: unregister failed for ${input.runId}`, err);
    }

    // Step 4: Reset worktree (best-effort) — independent of repoId
    // CRITICAL: Do NOT reset worktree if abort timed out, because a still-running
    // process may still be writing to the worktree and would race with the reset.
    let worktreeReset = false;
    if (abortStatus === 'timed_out') {
      this.deps.logger.error(
        `CancelRun: abort timed out for ${input.runId}; skipping worktree reset to avoid racing with still-running process`,
      );
    } else {
      try {
        const cwd = this.deps.findCwd(input.runId);
        const startCommitSha = this.deps.findStartCommitSha(input.runId);
        await git.resetHard(cwd, startCommitSha);
        await git.cleanUntracked(cwd);
        worktreeReset = true;
      } catch (err) {
        this.deps.logger.error(`CancelRun: worktree reset failed for ${input.runId}`, err);
      }
    }

    // Step 5: Release lease (best-effort) — requires repoId
    const repoId = run.repoId;
    if (repoId !== undefined) {
      try {
        const lease = leases.current(repoId);
        if (lease) {
          if (lease.runId !== input.runId) {
            this.deps.logger.error(
              `CancelRun: lease runId mismatch for repo ${repoId}: expected ${input.runId}, got ${lease.runId}`,
            );
          } else {
            leases.release({
              repoId,
              workerId: lease.workerId,
              runId: lease.runId,
              leaseToken: lease.leaseToken,
            });
          }
        }
      } catch (err) {
        if (!(err instanceof LeaseOwnershipLostError)) {
          this.deps.logger.error(`CancelRun: lease release failed for ${input.runId}`, err);
        }
      }
    }

    return {
      runId: input.runId,
      status: cancelled.status as RunStatus,
      abortStatus,
      worktreeReset,
    };
  }
}

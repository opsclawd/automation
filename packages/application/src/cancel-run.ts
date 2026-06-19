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

    // Step 1: Abort agent (best-effort)
    try {
      runAbort.abort(input.runId);
    } catch {
      /* continue */
    }

    // Step 2: Reset worktree (best-effort)
    try {
      const repoId = this.deps.findRepoId(input.runId);
      const cwd = this.deps.findCwd(repoId, input.runId);
      const startCommitSha = this.deps.findStartCommitSha(input.runId);
      await git.resetHard(cwd, startCommitSha);
    } catch {
      /* continue */
    }

    // Step 3: Release lease (best-effort)
    try {
      const repoId = this.deps.findRepoId(input.runId);
      const lease = leases.current(repoId);
      if (lease) leases.release(repoId, lease.workerId);
    } catch {
      /* continue */
    }

    // Step 4: Mark cancelled (MUST succeed — throws on failure)
    const cancelled = cancelRun(run, input.reason, now());
    const updated = this.deps.runRepository.updateStatusByUuid(input.runId, {
      status: cancelled.status,
      completedAt: cancelled.completedAt!,
      ...(cancelled.failureReason ? { failureReason: cancelled.failureReason } : {}),
    });
    if (!updated) {
      throw new Error(`Run ${input.runId} is already ${run.status}`);
    }
  }
}

import {
  canResume,
  resumeRun,
  createJob,
  WorkerLeaseConflictError,
  LeaseOwnershipLostError,
} from '@ai-sdlc/domain';
import { IssueNumber } from '@ai-sdlc/domain';
import type {
  RunId,
  WorkerId,
  JobId,
  Step,
  Phase,
  RunStatus,
  ResumeDisposition,
} from '@ai-sdlc/domain';
import type {
  RunRepositoryPort,
  RepositoryPort,
  WorkerLeasePort,
  JobQueuePort,
  PhaseRepositoryPort,
  StepRepositoryPort,
  LoggerPort,
  WorktreeLifecyclePort,
} from './ports.js';
import { orchestratorExcludePatterns } from './artifacts/orchestrator-artifacts.js';
import type { ResumeRunUseCase } from './use-cases.js';

// Acquired before atomic CAS to prevent concurrent workers from claiming the
// same run. Tradeoff: a crash between lease acquisition and the CAS orphans
// the lease for LEASE_TTL_MS. Tuned to 30s as a reasonable recovery bound.
const LEASE_TTL_MS = 30_000;
const RESUME_JOB_PRIORITY = 10; // priority for resumed runs

export interface ResumeRunDeps {
  runRepository: RunRepositoryPort;
  repos: RepositoryPort;
  leases: WorkerLeasePort;
  queue: JobQueuePort;
  stepRepo: StepRepositoryPort;
  phaseRepo: PhaseRepositoryPort;
  logger: LoggerPort;
  worktreeLifecycle?: WorktreeLifecyclePort;
  now?: () => Date;
}

export interface ResumeTransitionState {
  savedStatus: RunStatus;
  savedCompletedAt: Date | null;
  savedFailureReason: string | null;
  savedCurrentPhase: string | null;
  savedCompletedPhases: string[];
  savedSkippedPhases: string[];
  savedSteps: Step[];
  savedPhase?: Phase;
  effectiveDisposition: ResumeDisposition;
}

export class ResumeDispositionRequiredError extends Error {
  readonly allowedDispositions: readonly ResumeDisposition[] = [
    'preserve_working_tree',
    'reset_to_baseline',
  ];

  constructor(
    message = 'explicit resume disposition is required for dirty needs_human_review runs',
  ) {
    super(message);
    this.name = 'ResumeDispositionRequiredError';
  }
}

export function resolveResumeDisposition(
  status: RunStatus,
  meaningfulDirtyPaths: readonly string[],
  requestedDisposition?: ResumeDisposition,
): ResumeDisposition {
  if (requestedDisposition !== undefined) {
    return requestedDisposition;
  }
  if (status === 'needs_human_review') {
    if (meaningfulDirtyPaths.length > 0) {
      throw new ResumeDispositionRequiredError();
    }
    return 'reset_to_baseline';
  }
  return 'reset_to_baseline';
}

export class ResumeRun implements ResumeRunUseCase {
  constructor(readonly deps: ResumeRunDeps) {}

  private async getMeaningfulDirtyPaths(
    repoBasePath: string,
    issueNumber: number,
  ): Promise<string[]> {
    if (!this.deps.worktreeLifecycle) {
      return [];
    }
    try {
      const worktreeRoot = `${repoBasePath}/.ai-worktrees/issue-${issueNumber}`;
      const plan = await this.deps.worktreeLifecycle.inspect({
        cwd: worktreeRoot,
        mode: 'phase_boundary',
        preservedPatterns: orchestratorExcludePatterns(),
      });
      return plan.discardedPaths;
    } catch (err) {
      // A missing worktree is a legitimate "nothing to inspect" case — treat
      // it as clean. Any other inspection failure (transient git error,
      // permissions, corrupted repo) must NOT be silently treated as clean:
      // doing so would bypass resolveResumeDisposition's requirement that a
      // dirty needs_human_review run gets an explicit disposition before
      // being auto-reset. Fail closed instead by surfacing the error.
      const msg = err instanceof Error ? err.message : String(err);
      const lowerMsg = msg.toLowerCase();
      const isMissingWorktree =
        lowerMsg.includes('enoent') ||
        lowerMsg.includes('no such file or directory') ||
        lowerMsg.includes('does not exist') ||
        lowerMsg.includes('not a git repository') ||
        lowerMsg.includes('git not found on path') ||
        lowerMsg.includes('cannot change to') ||
        lowerMsg.includes('fatal: path');
      if (isMissingWorktree) {
        return [];
      }
      throw new Error(`failed to inspect worktree cleanliness for resume: ${msg}`);
    }
  }

  private async resolveEffectiveDisposition(
    repoBasePath: string,
    run: { status: RunStatus; issueNumber: number },
    requestedDisposition?: ResumeDisposition,
  ): Promise<ResumeDisposition> {
    if (requestedDisposition !== undefined) {
      return requestedDisposition;
    }
    const meaningfulDirtyPaths = await this.getMeaningfulDirtyPaths(repoBasePath, run.issueNumber);
    return resolveResumeDisposition(run.status, meaningfulDirtyPaths, requestedDisposition);
  }

  async transition(input: {
    runId: RunId;
    fromPhase?: string;
    workerId: WorkerId;
    attempt?: number;
    resumeDisposition?: ResumeDisposition;
  }): Promise<ResumeTransitionState> {
    const run = this.deps.runRepository.findByUuid(input.runId);
    if (!run) throw new Error(`No run found for ${input.runId}`);
    if (!canResume(run)) {
      throw new Error(`Cannot resume run ${input.runId}: status is '${run.status}'`);
    }

    const repoId = run.repoId;
    const repo = this.deps.repos.findById(repoId);
    if (!repo) throw new Error(`No repo found for run ${input.runId}`);
    if (repo.id !== run.repoId) {
      throw new Error(
        `Repo ID mismatch for run ${input.runId}: expected '${run.repoId}', got '${repo.id}'`,
      );
    }
    if (!repo.enabled) {
      throw new Error(`Cannot resume run ${input.runId}: repo '${repo.fullName}' is disabled`);
    }

    const effectiveDisposition = await this.resolveEffectiveDisposition(
      repo.localBasePath,
      run,
      input.resumeDisposition,
    );

    const savedStatus = run.status;
    const savedCompletedAt = run.completedAt;
    const savedFailureReason = run.failureReason;
    const savedCurrentPhase = run.currentPhase || null;
    const savedCompletedPhases = run.completedPhases;
    const savedSkippedPhases = run.skippedPhases;

    const reactivated = resumeRun(run, input.fromPhase);

    const savedSteps: Step[] = [];
    let savedPhase: Phase | undefined;
    if (input.fromPhase) {
      const originalSteps = this.deps.stepRepo
        .listForRun(input.runId)
        .filter((s: Step) => s.phaseId != null && s.phaseId === input.fromPhase);
      savedSteps.push(...originalSteps);
      const existingPhases = this.deps.phaseRepo.listByRun(input.runId);
      savedPhase = existingPhases.find((p) => p.name === input.fromPhase);
    }

    const updated = this.deps.runRepository.atomicUpdateByUuid(
      input.runId,
      {
        status: reactivated.status,
        currentPhase: null,
        completedAt: null,
        failureReason: null,
        completedPhases: reactivated.completedPhases,
        skippedPhases: reactivated.skippedPhases,
      },
      run.status,
    );
    if (!updated) {
      throw new Error(`Run ${input.runId} status could not be updated (concurrent modification)`);
    }

    try {
      if (input.fromPhase) {
        for (const step of savedSteps) {
          if (step.status === 'success') continue;
          const { startedAt: _sa, completedAt: _ca, ...stepFields } = step;
          this.deps.stepRepo.upsert({ ...stepFields, status: 'pending' });
        }
        const phase = {
          id: `${input.runId}-${input.fromPhase}`,
          runUuid: input.runId,
          name: input.fromPhase,
          status: 'pending' as const,
          attempt: input.attempt ?? 1,
        };
        this.deps.phaseRepo.insert(phase);
      }
    } catch (err) {
      const rollbackOk = this.deps.runRepository.atomicUpdateByUuid(
        input.runId,
        {
          status: savedStatus,
          completedAt: savedCompletedAt ?? null,
          failureReason: savedFailureReason ?? null,
          currentPhase: savedCurrentPhase ?? null,
          completedPhases: savedCompletedPhases,
          skippedPhases: savedSkippedPhases,
        },
        'running' as RunStatus,
      );
      if (!rollbackOk) {
        this.deps.logger.error(
          `ResumeRun: rollback CAS failed for ${input.runId} — status may be orphaned as 'running'`,
        );
      }
      for (const step of savedSteps) {
        this.deps.stepRepo.upsert({ ...step });
      }
      if (savedPhase) {
        this.deps.phaseRepo.update({ ...savedPhase });
      }
      throw err;
    }

    return {
      savedStatus,
      savedCompletedAt: savedCompletedAt ?? null,
      savedFailureReason: savedFailureReason ?? null,
      savedCurrentPhase: savedCurrentPhase ?? null,
      savedCompletedPhases,
      savedSkippedPhases,
      savedSteps,
      ...(savedPhase ? { savedPhase } : {}),
      effectiveDisposition,
    };
  }

  async execute(input: {
    runId: RunId;
    fromPhase?: string;
    workerId: WorkerId;
    attempt?: number;
    resumeDisposition?: ResumeDisposition;
  }): Promise<{ jobId: JobId; jobStatus: 'queued' }> {
    const now = this.deps.now ?? (() => new Date());
    const run = this.deps.runRepository.findByUuid(input.runId);
    if (!run) throw new Error(`No run found for ${input.runId}`);
    if (!canResume(run)) {
      throw new Error(`Cannot resume run ${input.runId}: status is '${run.status}'`);
    }

    const repoId = run.repoId;
    const repo = this.deps.repos.findById(repoId);
    if (!repo) throw new Error(`No repo found for run ${input.runId}`);
    if (repo.id !== run.repoId) {
      throw new Error(
        `Repo ID mismatch for run ${input.runId}: expected '${run.repoId}', got '${repo.id}'`,
      );
    }
    if (!repo.enabled) {
      throw new Error(`Cannot resume run ${input.runId}: repo '${repo.fullName}' is disabled`);
    }

    const effectiveDisposition = await this.resolveEffectiveDisposition(
      repo.localBasePath,
      run,
      input.resumeDisposition,
    );

    let leaseAcquired = false;
    let acquiredLease;
    try {
      acquiredLease = this.deps.leases.acquire({
        repoId: repo.id,
        workerId: input.workerId,
        runId: input.runId,
        now: now(),
        ttlMs: LEASE_TTL_MS,
      });
      leaseAcquired = true;
    } catch (err) {
      if (!(err instanceof WorkerLeaseConflictError)) {
        throw err;
      }
    }

    try {
      const transitionState = await this.transition({
        ...input,
        resumeDisposition: effectiveDisposition,
      });
      const job = createJob({
        id: `resume-${input.runId}-${now().getTime()}` as JobId,
        runId: input.runId,
        repoId: repo.id,
        issueNumber: IssueNumber(run.issueNumber),
        priority: RESUME_JOB_PRIORITY,
        createdAt: now(),
        resumeDisposition: transitionState.effectiveDisposition,
      });

      try {
        this.deps.queue.enqueue({ job });
      } catch (err) {
        const rollbackOk = this.deps.runRepository.atomicUpdateByUuid(
          input.runId,
          {
            status: transitionState.savedStatus,
            completedAt: transitionState.savedCompletedAt ?? null,
            failureReason: transitionState.savedFailureReason ?? null,
            currentPhase: transitionState.savedCurrentPhase ?? null,
            completedPhases: transitionState.savedCompletedPhases,
            skippedPhases: transitionState.savedSkippedPhases,
          },
          'running' as RunStatus,
        );
        if (!rollbackOk) {
          this.deps.logger.error(
            `ResumeRun: rollback CAS failed for ${input.runId} — status may be orphaned as 'running'`,
          );
        }
        for (const step of transitionState.savedSteps) {
          this.deps.stepRepo.upsert({ ...step });
        }
        if (transitionState.savedPhase) {
          this.deps.phaseRepo.update({ ...transitionState.savedPhase });
        }
        throw err;
      }

      if (leaseAcquired && acquiredLease) {
        try {
          this.deps.leases.release({
            repoId: repo.id,
            workerId: input.workerId,
            runId: input.runId,
            leaseToken: acquiredLease.leaseToken,
          });
        } catch (err) {
          if (!(err instanceof LeaseOwnershipLostError)) throw err;
        }
      }
      return { jobId: job.id, jobStatus: job.status as 'queued' };
    } catch (err) {
      if (leaseAcquired && acquiredLease) {
        try {
          this.deps.leases.release({
            repoId: repo.id,
            workerId: input.workerId,
            runId: input.runId,
            leaseToken: acquiredLease.leaseToken,
          });
        } catch (leaseErr) {
          if (!(leaseErr instanceof LeaseOwnershipLostError)) throw leaseErr;
        }
      }
      throw err;
    }
  }
}

import type { RepositoryId, IssueNumber, RunId, JobId, WorkerId } from '@ai-sdlc/domain';

export interface StartIssueRunUseCase {
  /** Enqueues a Job; never executes the phase pipeline inline. */
  execute(input: {
    repoId: RepositoryId;
    issueNumber: IssueNumber;
  }): Promise<{ runId: RunId; jobId: JobId }>;
}

export interface ResumeRunUseCase {
  execute(input: { runId: RunId; fromPhase?: string; workerId: WorkerId }): Promise<void>;
}

export interface RetryFailedPhaseUseCase {
  execute(input: { runId: RunId; workerId: WorkerId }): Promise<void>;
}

export interface CancelRunUseCase {
  execute(input: { runId: RunId; reason?: string }): Promise<void>;
}

export interface ClaimNextJobUseCase {
  execute(input: { workerId: WorkerId }): Promise<{ jobId: JobId } | undefined>;
}

export interface AcquireRepoLeaseUseCase {
  execute(input: { workerId: WorkerId; jobId: JobId }): Promise<void>;
}

export interface ReleaseRepoLeaseUseCase {
  execute(input: { workerId: WorkerId; repoId: RepositoryId }): Promise<void>;
}

// Agent-adjacent use cases (concrete impl depends on M3-06 AgentPort)
export interface RunAgentWithContractUseCase {
  execute(input: {
    runId: RunId;
    phaseName: string;
    profileName: string;
  }): Promise<{ ok: boolean }>;
}

export interface RunValidationUseCase {
  execute(input: { runId: RunId }): Promise<{ ok: boolean }>;
}

export interface ProcessPrReviewCommentsUseCase {
  execute(input: { runId: RunId }): Promise<{ processed: number }>;
}

export interface CreatePullRequestUseCase {
  execute(input: { runId: RunId }): Promise<{ prUrl: string }>;
}

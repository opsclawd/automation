import type {
  RepositoryId,
  RunId,
  JobId,
  WorkerId,
  RunStatus,
  ResumeDisposition,
  PinnedRuntime,
} from '@ai-sdlc/domain';
import type { AbortResult } from './ports/run-abort-port.js';

export interface ResumeRunUseCase {
  execute(input: {
    runId: RunId;
    fromPhase?: string;
    workerId: WorkerId;
    attempt?: number;
    resumeDisposition?: ResumeDisposition;
    pinnedRuntime?: PinnedRuntime;
  }): Promise<{ jobId: JobId; jobStatus: 'queued' }>;
}

export interface RetryFailedPhaseUseCase {
  execute(input: {
    runId: RunId;
    workerId: WorkerId;
    resumeDisposition?: ResumeDisposition;
    pinnedRuntime?: PinnedRuntime;
  }): Promise<unknown>;
}

export interface CancelRunResult {
  runId: RunId;
  status: RunStatus;
  abortStatus: AbortResult['status'];
  worktreeReset: boolean;
  branchSha?: string | undefined;
}

export interface CancelRunUseCase {
  execute(input: { runId: RunId; reason?: string }): Promise<CancelRunResult>;
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

import type {
  RepositoryId,
  RunId,
  WorkerId,
  WorkerLease,
  Job,
  JobOwnership,
  WorkerStatus,
  LeaseToken,
} from '@ai-sdlc/domain';

export type OperationalRecoveryConflictReason =
  | 'lease_generation_changed'
  | 'claim_generation_changed'
  | 'worker_status_changed'
  | 'job_not_found'
  | 'job_already_active';

export interface CommitLeaseReclamationInput {
  repoId: RepositoryId;
  leaseToken: LeaseToken;
  workerId: WorkerId;
  runId: RunId;
  now: Date;
  expectedLeaseGeneration: {
    workerId: WorkerId;
    runId: RunId;
  };
  expectedJobOwnership?: JobOwnership;
  expectedWorkerStatus?: WorkerStatus;
  auditReason: string;
}

export interface ReclaimExpiredClaimInput {
  repoId: RepositoryId;
  runId: RunId;
  now: Date;
}

export interface LeaseReclamationResult {
  committed: boolean;
  reason?: OperationalRecoveryConflictReason;
}

export interface OperationalRecoveryInspection {
  repoId: RepositoryId;
  hasActiveLease: boolean;
  activeLease?: WorkerLease;
  hasActiveJob: boolean;
  activeJob?: Job;
}

export interface OperationalRecoveryPort {
  inspect(repoId: RepositoryId, now: Date): OperationalRecoveryInspection;
  reclaimExpiredClaim(input: ReclaimExpiredClaimInput): LeaseReclamationResult;
  commitLeaseReclamation(input: CommitLeaseReclamationInput): LeaseReclamationResult;
}

import type { Db } from './database.js';
import type {
  RepositoryId,
  RunId,
  WorkerId,
  JobId,
  LeaseToken,
  WorkerLease,
  Job,
  WorkerStatus,
} from '@ai-sdlc/domain';
import { markWorkerUnhealthy } from '@ai-sdlc/domain';
import type { WorkerLeaseRepository } from './worker-lease-repository.js';
import type { WorkerRegistryRepository } from './worker-registry-repository.js';
import type { JobQueueRepository } from './job-queue-repository.js';
import type { EventRepository } from './event-repository.js';
import type {
  OperationalRecoveryPort,
  OperationalRecoveryInspection,
  CommitLeaseReclamationInput,
  ReclaimExpiredClaimInput,
  LeaseReclamationResult,
} from '@ai-sdlc/application/ports';
import { resetJobToQueued } from '@ai-sdlc/domain';

interface WorkerLeaseRow {
  repo_id: string;
  worker_id: string;
  run_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  lease_token: string;
}

interface WorkerRow {
  id: string;
  repo_id: string;
  hostname: string;
  process_id: number;
  status: string;
  heartbeat_at: string;
}

interface JobRow {
  id: string;
  run_id: string;
  repo_id: string;
  issue_number: number;
  status: string;
  priority: number;
  attempts: number;
  claimed_by: string | null;
  claim_token: string | null;
  created_at: string;
  claimed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  claim_expires_at: string | null;
}

function toWorkerLease(row: WorkerLeaseRow): WorkerLease {
  return {
    repoId: row.repo_id as RepositoryId,
    workerId: row.worker_id as WorkerId,
    runId: row.run_id as RunId,
    acquiredAt: new Date(row.acquired_at),
    heartbeatAt: new Date(row.heartbeat_at),
    expiresAt: new Date(row.expires_at),
    leaseToken: row.lease_token as LeaseToken,
  };
}

function toWorkerStatus(value: string): WorkerStatus {
  return value as WorkerStatus;
}

function toWorker(row: WorkerRow) {
  return {
    id: row.id as WorkerId,
    repoId: row.repo_id as RepositoryId,
    hostname: row.hostname,
    processId: row.process_id,
    status: toWorkerStatus(row.status),
    heartbeatAt: new Date(row.heartbeat_at),
  };
}

function toJob(row: JobRow): Job {
  const job: Job = {
    id: row.id as JobId,
    runId: row.run_id as RunId,
    repoId: row.repo_id as RepositoryId,
    issueNumber: row.issue_number as import('@ai-sdlc/domain').IssueNumber,
    status: row.status as import('@ai-sdlc/domain').JobStatus,
    priority: row.priority,
    attempts: row.attempts,
    createdAt: new Date(row.created_at),
  };
  if (row.claimed_by !== null) {
    job.claimedBy = row.claimed_by as WorkerId;
  }
  if (row.claim_token !== null) {
    job.claimToken = row.claim_token as import('@ai-sdlc/domain').ClaimToken;
  }
  if (row.claimed_at !== null) {
    job.claimedAt = new Date(row.claimed_at);
  }
  if (row.started_at !== null) {
    job.startedAt = new Date(row.started_at);
  }
  if (row.completed_at !== null) {
    job.completedAt = new Date(row.completed_at);
  }
  if (row.claim_expires_at !== null) {
    job.claimExpiresAt = new Date(row.claim_expires_at);
  }
  return job;
}

export class OperationalRecoveryRepository implements OperationalRecoveryPort {
  constructor(
    private readonly db: Db,
    private readonly deps: {
      leaseRepo: WorkerLeaseRepository;
      workerRepo: WorkerRegistryRepository;
      jobQueueRepo: JobQueueRepository;
      eventRepo: EventRepository;
    },
  ) {}

  inspect(repoId: RepositoryId, now: Date): OperationalRecoveryInspection {
    const leaseRow = this.db
      .prepare('SELECT * FROM worker_leases WHERE repo_id = @repo_id')
      .get({ repo_id: repoId }) as WorkerLeaseRow | undefined;

    const hasActiveLease =
      leaseRow !== undefined && new Date(leaseRow.expires_at).getTime() > now.getTime();
    const activeLease = leaseRow ? toWorkerLease(leaseRow) : undefined;

    const activeJobRows = this.db
      .prepare("SELECT * FROM jobs WHERE repo_id = @repo_id AND status IN ('claimed', 'running')")
      .all({ repo_id: repoId }) as JobRow[];
    const hasActiveJob = activeJobRows.length > 0;
    const activeJob = hasActiveJob && activeJobRows[0] ? toJob(activeJobRows[0]) : undefined;

    const inspection: OperationalRecoveryInspection = {
      repoId,
      hasActiveLease,
      hasActiveJob,
    };
    if (hasActiveLease && activeLease) {
      inspection.activeLease = activeLease;
    }
    if (hasActiveJob && activeJob) {
      inspection.activeJob = activeJob;
    }
    return inspection;
  }

  reclaimExpiredClaim(input: ReclaimExpiredClaimInput): LeaseReclamationResult {
    const tx = this.db.transaction((): LeaseReclamationResult => {
      const existingLease = this.db
        .prepare('SELECT * FROM worker_leases WHERE repo_id = @repo_id')
        .get({ repo_id: input.repoId }) as WorkerLeaseRow | undefined;

      if (existingLease && new Date(existingLease.expires_at).getTime() > input.now.getTime()) {
        return { committed: false, reason: 'lease_generation_changed' };
      }

      const activeJobRows = this.db
        .prepare(
          "SELECT * FROM jobs WHERE repo_id = @repo_id AND status IN ('queued', 'claimed', 'running')",
        )
        .all({ repo_id: input.repoId }) as JobRow[];

      const hasActiveNonExpiredJob = activeJobRows.some((row) => {
        if (row.status === 'queued') return true;
        if (row.status === 'claimed' || row.status === 'running') {
          if (
            row.claim_expires_at !== null &&
            new Date(row.claim_expires_at).getTime() > input.now.getTime()
          ) {
            return true;
          }
        }
        return false;
      });

      if (hasActiveNonExpiredJob) {
        return { committed: false, reason: 'job_already_active' };
      }

      const expiredClaimRows = this.db
        .prepare("SELECT * FROM jobs WHERE run_id = @run_id AND status IN ('claimed', 'running')")
        .all({ run_id: input.runId }) as JobRow[];

      if (expiredClaimRows.length === 0) {
        return { committed: false, reason: 'job_not_found' };
      }

      for (const row of expiredClaimRows) {
        const job = toJob(row);
        const requeued = resetJobToQueued(job);
        this.db
          .prepare(
            `UPDATE jobs
             SET status = @status,
                 claimed_by = NULL,
                 claim_token = NULL,
                 claimed_at = NULL,
                 claim_expires_at = NULL
             WHERE id = @id AND run_id = @run_id`,
          )
          .run({
            status: requeued.status,
            id: job.id,
            run_id: input.runId,
          });
      }

      this.deps.eventRepo.insert({
        runUuid: input.runId as string,
        level: 'info',
        type: 'lease.reclaimed',
        message: `Reclaimed expired claim for run ${input.runId}`,
        metadata: { repoId: input.repoId, runId: input.runId },
        timestamp: input.now,
      });

      return { committed: true };
    });

    return tx();
  }

  commitLeaseReclamation(input: CommitLeaseReclamationInput): LeaseReclamationResult {
    const tx = this.db.transaction((): LeaseReclamationResult => {
      const leaseRow = this.db
        .prepare('SELECT * FROM worker_leases WHERE repo_id = @repo_id')
        .get({ repo_id: input.repoId }) as WorkerLeaseRow | undefined;

      if (!leaseRow) {
        return { committed: false, reason: 'lease_generation_changed' };
      }

      if (leaseRow.lease_token !== input.leaseToken) {
        return { committed: false, reason: 'lease_generation_changed' };
      }

      if (leaseRow.worker_id !== input.expectedLeaseGeneration.workerId) {
        return { committed: false, reason: 'lease_generation_changed' };
      }

      if (leaseRow.run_id !== input.expectedLeaseGeneration.runId) {
        return { committed: false, reason: 'lease_generation_changed' };
      }

      const workerRow = this.db
        .prepare('SELECT * FROM workers WHERE id = @id AND repo_id = @repo_id')
        .get({ id: input.expectedLeaseGeneration.workerId, repo_id: input.repoId }) as
        | WorkerRow
        | undefined;

      if (!workerRow) {
        return { committed: false, reason: 'worker_status_changed' };
      }

      if (
        input.expectedWorkerStatus !== undefined &&
        workerRow.status !== input.expectedWorkerStatus
      ) {
        return { committed: false, reason: 'worker_status_changed' };
      }

      if (input.expectedJobOwnership) {
        const jobRow = this.db
          .prepare('SELECT * FROM jobs WHERE id = @id')
          .get({ id: input.expectedJobOwnership.jobId }) as JobRow | undefined;

        if (!jobRow) {
          return { committed: false, reason: 'job_not_found' };
        }

        if (jobRow.claimed_by !== input.expectedJobOwnership.workerId) {
          return { committed: false, reason: 'claim_generation_changed' };
        }

        if (jobRow.claim_token !== input.expectedJobOwnership.claimToken) {
          return { committed: false, reason: 'claim_generation_changed' };
        }

        const job = toJob(jobRow);
        const requeued = resetJobToQueued(job);
        this.db
          .prepare(
            `UPDATE jobs
             SET status = @status,
                 claimed_by = NULL,
                 claim_token = NULL,
                 claimed_at = NULL,
                 claim_expires_at = NULL
             WHERE id = @id AND claimed_by = @claimed_by AND claim_token = @claim_token`,
          )
          .run({
            status: requeued.status,
            id: job.id,
            claimed_by: input.expectedJobOwnership.workerId,
            claim_token: input.expectedJobOwnership.claimToken,
          });
      }

      const updatedWorker = markWorkerUnhealthy(toWorker(workerRow));
      this.db
        .prepare('UPDATE workers SET status = @status WHERE id = @id AND repo_id = @repo_id')
        .run({
          status: updatedWorker.status,
          id: input.expectedLeaseGeneration.workerId,
          repo_id: input.repoId,
        });

      this.db
        .prepare(
          `DELETE FROM worker_leases
           WHERE repo_id = @repo_id
             AND worker_id = @worker_id
             AND run_id = @run_id
             AND lease_token = @lease_token`,
        )
        .run({
          repo_id: input.repoId,
          worker_id: input.expectedLeaseGeneration.workerId,
          run_id: input.expectedLeaseGeneration.runId,
          lease_token: input.leaseToken,
        });

      this.deps.eventRepo.insert({
        runUuid: input.runId as string,
        level: 'info',
        type: 'lease.reclaimed',
        message: `Lease reclaimed: ${input.auditReason}`,
        metadata: {
          repoId: input.repoId,
          workerId: input.expectedLeaseGeneration.workerId,
          reclaimedByWorkerId: input.workerId,
          leaseToken: input.leaseToken,
          reason: input.auditReason,
        },
        timestamp: input.now,
      });

      return { committed: true };
    });

    return tx();
  }
}

import { randomUUID } from 'node:crypto';
import {
  type ReleaseBatch,
  type ReleaseBatchItem,
  type ReleaseBatchStatus,
  ReleaseBatchId,
  RepositoryId,
  RunId,
  JobId,
  IssueNumber,
  type Run,
  type ExecutionPolicy,
  type Repository,
  createRun,
  createJob,
  admitItem,
  unblockItem,
  attachItemPr,
  markItemWaitingMerge,
  markItemMerged,
  markItemBlocked,
  markBatchBlocked,
  ReleaseBatchStateError,
} from '@ai-sdlc/domain';
import { newRunId } from '@ai-sdlc/shared';
import type {
  ReleaseBatchRepositoryPort,
  RunRepositoryPort,
  JobQueuePort,
  EventBusPort,
  EventRepositoryPort,
  GitPort,
  GitHubPort,
  PrMergeReadiness,
} from './ports.js';
import type { EventRepositoryFactory } from './start-issue-run.js';
import type { InterItemMaintenanceService } from './inter-item-maintenance.js';

export type ReconciliationAction =
  | 'idle'
  | 'unblocked'
  | 'blocked'
  | 'successor_admitted'
  | 'pr_attached'
  | 'build_completed'
  | 'job_recovered'
  | 'run_adopted'
  | 'item_merged'
  | 'maintenance_run';

export interface ReconcileBatchResult {
  batchId: ReleaseBatchId;
  batchStatus: ReleaseBatchStatus;
  currentPosition: number;
  actions: ReconciliationAction[];
  batch: ReleaseBatch;
}

export interface CertifyItemMergedInput {
  batchId: ReleaseBatchId;
  position: number;
  mergedCommitSha: string;
  now?: Date;
}

export interface ReleaseBatchCoordinatorDeps {
  releaseBatchRepository: ReleaseBatchRepositoryPort;
  runRepository: RunRepositoryPort;
  jobQueue: JobQueuePort;
  repositoryPort: {
    findById(id: RepositoryId): Repository | undefined;
    listEnabled(): Repository[];
  };
  eventBus: EventBusPort;
  eventRepository?: EventRepositoryPort | EventRepositoryFactory | undefined;
  git?: GitPort;
  github?: GitHubPort;
  maintenanceService?: InterItemMaintenanceService;
  resolvePrMetadata?: (run: Run) => Promise<{ prNumber: number } | undefined>;
  executionPolicy?: ExecutionPolicy | undefined;
  now?: (() => Date) | undefined;
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string, err?: unknown) => void;
  };
}

export class ReleaseBatchCoordinator {
  constructor(private readonly deps: ReleaseBatchCoordinatorDeps) {}

  async reconcile(batchId: ReleaseBatchId): Promise<ReconcileBatchResult> {
    const now = (this.deps.now ?? (() => new Date()))();
    const found = this.deps.releaseBatchRepository.findById(batchId);
    if (!found) {
      throw new ReleaseBatchStateError(`ReleaseBatch ${batchId} not found`);
    }
    let batch: ReleaseBatch = found;

    const actions: ReconciliationAction[] = [];

    // Terminal batches cannot advance
    if (batch.status === 'completed' || batch.status === 'cancelled') {
      return {
        batchId: batch.id,
        batchStatus: batch.status,
        currentPosition: batch.currentPosition,
        actions: ['idle'],
        batch,
      };
    }

    // Identify current unmerged items
    const unmergedItems = batch.items.filter((i) => i.status !== 'merged');

    if (unmergedItems.length === 0) {
      // All items in the batch are merged: complete build-stage sequencing
      actions.push('build_completed');
      this.publishEvent(batch, {
        type: 'release_batch.build_stage_completed',
        level: 'info',
        message: `release-batch ${batch.id} completed build stage: all ${batch.items.length} items merged`,
        timestamp: now,
        metadata: {
          releaseBatchId: batch.id,
          totalItems: batch.items.length,
          positions: batch.items.map((i) => i.position),
        },
      });

      return {
        batchId: batch.id,
        batchStatus: batch.status,
        currentPosition: batch.currentPosition,
        actions,
        batch,
      };
    }

    const currentItem = unmergedItems[0]!;

    // Case 1: Current item is pending (needs admission)
    if (currentItem.status === 'pending') {
      // Precondition: all prior items must be merged
      const priorUnmerged = batch.items.filter(
        (i) => i.position < currentItem.position && i.status !== 'merged',
      );
      if (priorUnmerged.length > 0) {
        return {
          batchId: batch.id,
          batchStatus: batch.status,
          currentPosition: batch.currentPosition,
          actions: ['idle'],
          batch,
        };
      }

      // Precondition: if batch is blocked, check if we can retry maintenance if it was an environment blocker
      if (batch.status === 'blocked') {
        const isEnvBlocker =
          batch.blockedReason?.startsWith('environment_unhealthy') ||
          batch.blockedReason?.startsWith('Disk free space') ||
          batch.blockedReason?.startsWith('Available memory');

        if (isEnvBlocker && this.deps.maintenanceService && currentItem.position > 1) {
          const repo = this.deps.repositoryPort.findById(batch.repoId);
          const priorItem = batch.items.find((i) => i.position === currentItem.position - 1);
          if (repo && priorItem) {
            const retryMaint = await this.deps.maintenanceService.execute({
              repoLocalBasePath: repo.localBasePath,
              completedIssueNumber: priorItem.issueNumber,
              completedRunUuid: priorItem.runUuid,
            });
            if (retryMaint.success) {
              const { blockedReason: _br, ...unblockedBatch } = batch;
              void _br;
              batch = { ...unblockedBatch, status: 'building' };
              this.deps.releaseBatchRepository.update(batch);
              actions.push('unblocked');
              this.publishEvent(batch, {
                type: 'release_batch.unblocked',
                level: 'info',
                message: `release-batch ${batch.id} unblocked: maintenance health checks passed`,
                timestamp: now,
                metadata: {
                  releaseBatchId: batch.id,
                  position: currentItem.position,
                },
              });
            } else {
              return {
                batchId: batch.id,
                batchStatus: batch.status,
                currentPosition: batch.currentPosition,
                actions: ['idle'],
                batch,
              };
            }
          } else {
            return {
              batchId: batch.id,
              batchStatus: batch.status,
              currentPosition: batch.currentPosition,
              actions: ['idle'],
              batch,
            };
          }
        } else {
          return {
            batchId: batch.id,
            batchStatus: batch.status,
            currentPosition: batch.currentPosition,
            actions: ['idle'],
            batch,
          };
        }
      }

      // Precondition: no other item may be active or waiting_merge
      const otherActive = batch.items.find(
        (i) =>
          i.position !== currentItem.position &&
          (i.status === 'active' || i.status === 'waiting_merge'),
      );
      if (otherActive) {
        return {
          batchId: batch.id,
          batchStatus: batch.status,
          currentPosition: batch.currentPosition,
          actions: ['idle'],
          batch,
        };
      }

      // Inter-item maintenance before successor admission
      if (currentItem.position > 1 && this.deps.maintenanceService) {
        const repo = this.deps.repositoryPort.findById(batch.repoId);
        const priorItem = batch.items.find((i) => i.position === currentItem.position - 1);
        if (repo && priorItem) {
          const mResult = await this.deps.maintenanceService.execute({
            repoLocalBasePath: repo.localBasePath,
            completedIssueNumber: priorItem.issueNumber,
            completedRunUuid: priorItem.runUuid,
          });
          if (!mResult.success) {
            const reason = mResult.reason ?? 'environment_unhealthy';
            batch = markBatchBlocked(batch, reason);
            this.deps.releaseBatchRepository.update(batch);
            actions.push('blocked');
            this.publishEvent(batch, {
              type: 'release_batch.blocked',
              level: 'warn',
              message: `release-batch ${batch.id} blocked: maintenance check failed: ${reason}`,
              timestamp: now,
              metadata: {
                releaseBatchId: batch.id,
                position: currentItem.position,
                blockedReason: reason,
              },
            });
            return {
              batchId: batch.id,
              batchStatus: batch.status,
              currentPosition: batch.currentPosition,
              actions,
              batch,
            };
          }
          actions.push('maintenance_run');
        }
      }

      // Fresh release-base certification: fetch origin/<releaseBranch> and resolve exact SHA
      let freshBaseSha =
        currentItem.baseSha ?? this.resolveBaseShaForPosition(batch, currentItem.position);
      const repo = this.deps.repositoryPort.findById(batch.repoId);
      if (this.deps.git && repo) {
        try {
          await this.deps.git.fetch(repo.localBasePath, 'origin', batch.releaseBranch);
          const remoteSha = await this.deps.git.resolveRef(
            repo.localBasePath,
            `origin/${batch.releaseBranch}`,
          );
          if (remoteSha) {
            freshBaseSha = remoteSha;
          }
        } catch (err) {
          this.deps.logger?.warn?.(
            `Failed to fetch or resolve origin/${batch.releaseBranch}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // Admit successor with certified fresh SHA
      const admissionResult = await this.admitSuccessor(batch, currentItem, now, freshBaseSha);
      batch = admissionResult.batch;
      actions.push(...admissionResult.actions);

      return {
        batchId: batch.id,
        batchStatus: batch.status,
        currentPosition: batch.currentPosition,
        actions,
        batch,
      };
    }

    // Case 2: Current item has been marked active/blocked but runUuid might be missing (crash window)
    if (!currentItem.runUuid) {
      const existingRun = this.findMatchingRun(
        batch.repoId,
        currentItem.issueNumber,
        batch.releaseBranch,
      );
      if (existingRun) {
        batch = admitItem(batch, currentItem.position, {
          runUuid: existingRun.uuid,
          baseSha:
            currentItem.baseSha ?? this.resolveBaseShaForPosition(batch, currentItem.position),
          now,
        });
        this.deps.releaseBatchRepository.update(batch);
        actions.push('run_adopted');
      } else {
        const admissionResult = await this.admitSuccessor(batch, currentItem, now);
        batch = admissionResult.batch;
        actions.push(...admissionResult.actions);
        return {
          batchId: batch.id,
          batchStatus: batch.status,
          currentPosition: batch.currentPosition,
          actions,
          batch,
        };
      }
    }

    const runUuid = currentItem.runUuid!;
    const run = this.deps.runRepository.findByUuid(runUuid);
    if (!run) {
      return {
        batchId: batch.id,
        batchStatus: batch.status,
        currentPosition: batch.currentPosition,
        actions: ['idle'],
        batch,
      };
    }

    // Run-state reconciliation table
    switch (run.status) {
      case 'queued':
      case 'running': {
        // Crash window check: ensure Job exists in jobQueue
        const jobRecovered = this.ensureJobEnqueued(
          batch.repoId,
          runUuid,
          currentItem.issueNumber,
          now,
        );
        if (jobRecovered) {
          actions.push('job_recovered');
        }

        // If item was blocked due to run state, unblock it!
        const isRunBlocker = [
          'run_failed',
          'run_blocked',
          'run_cancelled',
          'needs_human_review',
        ].includes(currentItem.blockedReason ?? '');
        if (isRunBlocker) {
          batch = unblockItem(batch, currentItem.position);
          this.deps.releaseBatchRepository.update(batch);
          actions.push('unblocked');

          this.publishEvent(batch, {
            type: 'release_batch.unblocked',
            level: 'info',
            message: `release-batch ${batch.id} unblocked: run ${runUuid} for issue #${currentItem.issueNumber} became active`,
            timestamp: now,
            metadata: {
              releaseBatchId: batch.id,
              position: currentItem.position,
              issueNumber: currentItem.issueNumber,
              runUuid,
            },
          });
        }

        // Attach PR metadata if available
        const prAttached = await this.tryAttachPrMetadata(batch, currentItem, run);
        if (prAttached) {
          batch = prAttached.batch;
          actions.push('pr_attached');
        }
        break;
      }

      case 'waiting': {
        const isRunBlocker = [
          'run_failed',
          'run_blocked',
          'run_cancelled',
          'needs_human_review',
        ].includes(currentItem.blockedReason ?? '');
        if (isRunBlocker) {
          batch = unblockItem(batch, currentItem.position);
          this.deps.releaseBatchRepository.update(batch);
          actions.push('unblocked');
        }

        // Check PR metadata and transition item to waiting_merge if known
        const prAttached = await this.tryAttachPrMetadata(batch, currentItem, run);
        if (prAttached) {
          batch = prAttached.batch;
          actions.push('pr_attached');
        }

        const prNum = currentItem.prNumber ?? (prAttached ? prAttached.prNumber : undefined);
        const latestItem = batch.items.find((i) => i.position === currentItem.position);
        if (prNum && latestItem && latestItem.status === 'active') {
          batch = markItemWaitingMerge(batch, currentItem.position, prNum);
          this.deps.releaseBatchRepository.update(batch);
          actions.push('pr_attached');

          this.publishEvent(batch, {
            type: 'release_batch.item_waiting_merge',
            level: 'info',
            message: `release-batch ${batch.id} item #${currentItem.issueNumber} waiting merge on PR #${prNum}`,
            timestamp: now,
            metadata: {
              releaseBatchId: batch.id,
              position: currentItem.position,
              issueNumber: currentItem.issueNumber,
              runUuid,
              prNumber: prNum,
            },
          });
        }
        break;
      }

      case 'failed': {
        if (currentItem.status !== 'blocked' || currentItem.blockedReason !== 'run_failed') {
          batch = markItemBlocked(batch, currentItem.position, 'run_failed');
          this.deps.releaseBatchRepository.update(batch);
          actions.push('blocked');

          this.publishEvent(batch, {
            type: 'release_batch.blocked',
            level: 'warn',
            message: `release-batch ${batch.id} blocked: run ${runUuid} failed for issue #${currentItem.issueNumber}`,
            timestamp: now,
            metadata: {
              releaseBatchId: batch.id,
              position: currentItem.position,
              issueNumber: currentItem.issueNumber,
              runUuid,
              blockedReason: 'run_failed',
            },
          });
        }
        break;
      }

      case 'blocked': {
        if (currentItem.status !== 'blocked' || currentItem.blockedReason !== 'run_blocked') {
          batch = markItemBlocked(batch, currentItem.position, 'run_blocked');
          this.deps.releaseBatchRepository.update(batch);
          actions.push('blocked');

          this.publishEvent(batch, {
            type: 'release_batch.blocked',
            level: 'warn',
            message: `release-batch ${batch.id} blocked: run ${runUuid} blocked for issue #${currentItem.issueNumber}`,
            timestamp: now,
            metadata: {
              releaseBatchId: batch.id,
              position: currentItem.position,
              issueNumber: currentItem.issueNumber,
              runUuid,
              blockedReason: 'run_blocked',
            },
          });
        }
        break;
      }

      case 'needs_human_review': {
        if (
          currentItem.status !== 'blocked' ||
          currentItem.blockedReason !== 'needs_human_review'
        ) {
          batch = markItemBlocked(batch, currentItem.position, 'needs_human_review');
          this.deps.releaseBatchRepository.update(batch);
          actions.push('blocked');

          this.publishEvent(batch, {
            type: 'release_batch.blocked',
            level: 'warn',
            message: `release-batch ${batch.id} blocked: run ${runUuid} needs human review for issue #${currentItem.issueNumber}`,
            timestamp: now,
            metadata: {
              releaseBatchId: batch.id,
              position: currentItem.position,
              issueNumber: currentItem.issueNumber,
              runUuid,
              blockedReason: 'needs_human_review',
            },
          });
        }
        break;
      }

      case 'cancelled': {
        if (currentItem.status !== 'blocked' || currentItem.blockedReason !== 'run_cancelled') {
          batch = markItemBlocked(batch, currentItem.position, 'run_cancelled');
          this.deps.releaseBatchRepository.update(batch);
          actions.push('blocked');

          this.publishEvent(batch, {
            type: 'release_batch.blocked',
            level: 'warn',
            message: `release-batch ${batch.id} blocked: run ${runUuid} cancelled for issue #${currentItem.issueNumber}`,
            timestamp: now,
            metadata: {
              releaseBatchId: batch.id,
              position: currentItem.position,
              issueNumber: currentItem.issueNumber,
              runUuid,
              blockedReason: 'run_cancelled',
            },
          });
        }
        break;
      }

      case 'passed': {
        // Run passed alone CANNOT admit a successor without downstream merge certification.
        // Preserve current item.
        const prAttached = await this.tryAttachPrMetadata(batch, currentItem, run);
        if (prAttached) {
          batch = prAttached.batch;
          actions.push('pr_attached');
        }
        break;
      }
    }

    // Check and reconcile PR merge status if GitHub port and PR metadata are available
    const latestItem = batch.items.find((i) => i.position === currentItem.position);
    const prNum = latestItem?.prNumber;
    if (this.deps.github && prNum && run.status !== 'failed' && run.status !== 'cancelled') {
      const prResult = await this.checkAndReconcilePrMerge(batch, currentItem.position, prNum, now);
      if (prResult.certifyResult) {
        return prResult.certifyResult;
      }
      batch = prResult.batch;
      actions.push(...prResult.actions);
    }

    if (actions.length === 0) {
      actions.push('idle');
    }

    return {
      batchId: batch.id,
      batchStatus: batch.status,
      currentPosition: batch.currentPosition,
      actions,
      batch,
    };
  }

  async certifyItemMerged(input: CertifyItemMergedInput): Promise<ReconcileBatchResult> {
    const now = input.now ?? (this.deps.now ? this.deps.now() : new Date());
    const batch = this.deps.releaseBatchRepository.findById(input.batchId);
    if (!batch) {
      throw new ReleaseBatchStateError(`ReleaseBatch ${input.batchId} not found`);
    }

    const item = batch.items.find((i) => i.position === input.position);
    if (!item) {
      throw new ReleaseBatchStateError(
        `Position ${input.position} not found in release batch ${batch.id}`,
      );
    }

    // Idempotent check
    if (item.status === 'merged' && item.mergedCommitSha === input.mergedCommitSha) {
      return this.reconcile(input.batchId);
    }

    const updatedBatch = markItemMerged(batch, input.position, {
      mergedCommitSha: input.mergedCommitSha,
      now,
    });
    this.deps.releaseBatchRepository.update(updatedBatch);

    this.publishEvent(updatedBatch, {
      type: 'release_batch.item_merged',
      level: 'info',
      message: `release-batch ${batch.id} item #${item.issueNumber} at position ${item.position} certified merged (${input.mergedCommitSha})`,
      timestamp: now,
      metadata: {
        releaseBatchId: batch.id,
        position: item.position,
        issueNumber: item.issueNumber,
        runUuid: item.runUuid,
        mergedCommitSha: input.mergedCommitSha,
      },
    });

    return this.reconcile(input.batchId);
  }

  async reconcileAll(repoId?: RepositoryId): Promise<ReconcileBatchResult[]> {
    const batches: ReleaseBatch[] = [];
    if (repoId) {
      batches.push(...this.deps.releaseBatchRepository.listForRepo(repoId));
    } else {
      const repos = this.deps.repositoryPort.listEnabled();
      for (const r of repos) {
        batches.push(...this.deps.releaseBatchRepository.listForRepo(r.id));
      }
    }

    const results: ReconcileBatchResult[] = [];
    for (const b of batches) {
      if (b.status === 'completed' || b.status === 'cancelled') {
        continue;
      }
      results.push(await this.reconcile(b.id));
    }
    return results;
  }

  private resolveBaseShaForPosition(batch: ReleaseBatch, position: number): string {
    if (position > 1) {
      const prev = batch.items.find((i) => i.position === position - 1);
      if (prev && prev.mergedCommitSha) {
        return prev.mergedCommitSha;
      }
    }
    return batch.sourceStartSha;
  }

  private findMatchingRun(
    repoId: RepositoryId,
    issueNumber: number,
    releaseBranch: string,
  ): Run | undefined {
    const activeRun = this.deps.runRepository.findByIssueNumber(repoId, issueNumber);
    if (activeRun && activeRun.baseBranch === releaseBranch) {
      return activeRun;
    }
    return undefined;
  }

  private async admitSuccessor(
    batch: ReleaseBatch,
    item: ReleaseBatchItem,
    now: Date,
    explicitBaseSha?: string,
  ): Promise<{ batch: ReleaseBatch; actions: ReconciliationAction[] }> {
    const actions: ReconciliationAction[] = [];
    let runUuid: string;
    let runDisplayId: string;

    const existingRun = this.findMatchingRun(batch.repoId, item.issueNumber, batch.releaseBranch);
    if (existingRun) {
      runUuid = existingRun.uuid;
      runDisplayId = existingRun.displayId;
      actions.push('run_adopted');
    } else {
      const ids = newRunId({ issueNumber: item.issueNumber, now });
      runUuid = ids.uuid;
      runDisplayId = ids.displayId;

      const run = createRun({
        uuid: ids.uuid,
        displayId: ids.displayId,
        repoId: batch.repoId,
        issueNumber: item.issueNumber,
        startedAt: now,
        executionPolicy: this.deps.executionPolicy ?? 'standard',
        baseBranch: batch.releaseBranch,
      });

      try {
        this.deps.runRepository.insertIfNoActive(run);
      } catch (err) {
        // Crash/concurrency safety: check if another worker or previous attempt inserted it
        const conflictRun = this.deps.runRepository.findByIssueNumber(
          batch.repoId,
          item.issueNumber,
        );
        if (conflictRun && conflictRun.baseBranch === batch.releaseBranch) {
          runUuid = conflictRun.uuid;
          runDisplayId = conflictRun.displayId;
          actions.push('run_adopted');
        } else {
          throw err;
        }
      }
    }

    // Ensure Job exists in jobQueue
    const jobRecovered = this.ensureJobEnqueued(batch.repoId, runUuid, item.issueNumber, now);
    if (jobRecovered) {
      actions.push('job_recovered');
    }

    const baseSha =
      explicitBaseSha ?? item.baseSha ?? this.resolveBaseShaForPosition(batch, item.position);
    this.deps.runRepository.update(runUuid, { startCommitSha: baseSha });

    const updatedBatch = admitItem(batch, item.position, {
      runUuid,
      baseSha,
      now,
    });
    this.deps.releaseBatchRepository.update(updatedBatch);
    actions.push('successor_admitted');

    this.publishEvent(updatedBatch, {
      type: 'release_batch.item_admitted',
      level: 'info',
      message: `release-batch ${batch.id} admitted issue #${item.issueNumber} at position ${item.position} (run ${runUuid})`,
      timestamp: now,
      metadata: {
        releaseBatchId: batch.id,
        position: item.position,
        issueNumber: item.issueNumber,
        runUuid,
        runDisplayId,
        releaseBranch: batch.releaseBranch,
        baseSha,
      },
    });

    return { batch: updatedBatch, actions };
  }

  private ensureJobEnqueued(
    repoId: RepositoryId,
    runUuid: string,
    issueNumber: number,
    now: Date,
  ): boolean {
    const repoJobs = this.deps.jobQueue.listForRepo(repoId);
    const existingJob = repoJobs.find(
      (j) =>
        (j.runId as unknown as string) === runUuid &&
        ['queued', 'claimed', 'running'].includes(j.status),
    );
    if (existingJob) {
      return false;
    }

    const jobId = JobId(randomUUID());
    const job = createJob({
      id: jobId,
      runId: RunId(runUuid),
      repoId,
      issueNumber: IssueNumber(issueNumber),
      priority: 0,
      createdAt: now,
    });
    this.deps.jobQueue.enqueue({ job });
    return true;
  }

  private async tryAttachPrMetadata(
    batch: ReleaseBatch,
    item: ReleaseBatchItem,
    run: Run,
  ): Promise<{ batch: ReleaseBatch; prNumber: number } | undefined> {
    if (item.prNumber) {
      return undefined;
    }

    if (!this.deps.resolvePrMetadata) {
      return undefined;
    }

    try {
      const meta = await this.deps.resolvePrMetadata(run);
      if (meta && meta.prNumber) {
        const updatedBatch = attachItemPr(batch, item.position, meta.prNumber);
        this.deps.releaseBatchRepository.update(updatedBatch);
        return { batch: updatedBatch, prNumber: meta.prNumber };
      }
    } catch (err) {
      this.deps.logger?.warn?.(
        `Failed to resolve PR metadata for run ${run.uuid}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return undefined;
  }

  private async checkAndReconcilePrMerge(
    batch: ReleaseBatch,
    position: number,
    prNumber: number,
    now: Date,
  ): Promise<{
    batch: ReleaseBatch;
    actions: ReconciliationAction[];
    certifyResult?: ReconcileBatchResult;
  }> {
    const actions: ReconciliationAction[] = [];
    if (!this.deps.github) {
      return { batch, actions };
    }

    const repo = this.deps.repositoryPort.findById(batch.repoId);
    if (!repo) {
      return { batch, actions };
    }

    let readiness: PrMergeReadiness;
    try {
      readiness = await this.deps.github.getPrMergeReadiness(repo.fullName, prNumber);
    } catch (err) {
      this.deps.logger?.warn?.(
        `Failed to get PR merge readiness for PR #${prNumber} in ${repo.fullName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { batch, actions };
    }

    const currentItem = batch.items.find((i) => i.position === position);
    if (!currentItem) {
      return { batch, actions };
    }

    // 1. PR Base Branch Mismatch Check
    if (readiness.baseRefName && readiness.baseRefName !== batch.releaseBranch) {
      const reason = `pr_base_mismatch: PR #${prNumber} base is ${readiness.baseRefName}, expected ${batch.releaseBranch}`;
      if (currentItem.status !== 'blocked' || currentItem.blockedReason !== reason) {
        batch = markItemBlocked(batch, position, reason);
        this.deps.releaseBatchRepository.update(batch);
        actions.push('blocked');
        this.publishEvent(batch, {
          type: 'release_batch.blocked',
          level: 'warn',
          message: `release-batch ${batch.id} blocked: ${reason}`,
          timestamp: now,
          metadata: {
            releaseBatchId: batch.id,
            position,
            issueNumber: currentItem.issueNumber,
            runUuid: currentItem.runUuid,
            prNumber,
            blockedReason: reason,
          },
        });
      }
      return { batch, actions };
    }

    // 2. Closed Unmerged Check
    if (readiness.state === 'closed' && !readiness.isMerged) {
      const reason = `pr_closed_unmerged: PR #${prNumber} closed without merge`;
      if (currentItem.status !== 'blocked' || currentItem.blockedReason !== reason) {
        batch = markItemBlocked(batch, position, reason);
        this.deps.releaseBatchRepository.update(batch);
        actions.push('blocked');
        this.publishEvent(batch, {
          type: 'release_batch.blocked',
          level: 'warn',
          message: `release-batch ${batch.id} blocked: ${reason}`,
          timestamp: now,
          metadata: {
            releaseBatchId: batch.id,
            position,
            issueNumber: currentItem.issueNumber,
            runUuid: currentItem.runUuid,
            prNumber,
            blockedReason: reason,
          },
        });
      }
      return { batch, actions };
    }

    // 3. Auto-Merge Disabled / Unavailable Check
    if (
      readiness.autoMergeEnabled === false &&
      !readiness.isMerged &&
      readiness.state !== 'merged'
    ) {
      const reason = `auto_merge_unavailable: PR #${prNumber} does not have auto-merge enabled`;
      if (currentItem.status !== 'blocked' || currentItem.blockedReason !== reason) {
        batch = markItemBlocked(batch, position, reason);
        this.deps.releaseBatchRepository.update(batch);
        actions.push('blocked');
        this.publishEvent(batch, {
          type: 'release_batch.blocked',
          level: 'warn',
          message: `release-batch ${batch.id} blocked: ${reason}`,
          timestamp: now,
          metadata: {
            releaseBatchId: batch.id,
            position,
            issueNumber: currentItem.issueNumber,
            runUuid: currentItem.runUuid,
            prNumber,
            blockedReason: reason,
          },
        });
      }
      return { batch, actions };
    }

    // 4. CI Failure Check
    if (readiness.ciStatus === 'failed' && !readiness.isMerged && readiness.state !== 'merged') {
      const reason = `ci_failed: PR #${prNumber} CI checks failed`;
      if (currentItem.status !== 'blocked' || currentItem.blockedReason !== reason) {
        batch = markItemBlocked(batch, position, reason);
        this.deps.releaseBatchRepository.update(batch);
        actions.push('blocked');
        this.publishEvent(batch, {
          type: 'release_batch.blocked',
          level: 'warn',
          message: `release-batch ${batch.id} blocked: ${reason}`,
          timestamp: now,
          metadata: {
            releaseBatchId: batch.id,
            position,
            issueNumber: currentItem.issueNumber,
            runUuid: currentItem.runUuid,
            prNumber,
            blockedReason: reason,
          },
        });
      }
      return { batch, actions };
    }

    // If item was blocked due to a PR issue (ci_failed, auto_merge_unavailable, pr_base_mismatch),
    // but the issue has been resolved, unblock it!
    const isPrBlocker =
      currentItem.status === 'blocked' &&
      (currentItem.blockedReason?.startsWith('ci_failed') ||
        currentItem.blockedReason?.startsWith('auto_merge_unavailable') ||
        currentItem.blockedReason?.startsWith('pr_base_mismatch'));

    if (isPrBlocker) {
      batch = unblockItem(batch, position);
      this.deps.releaseBatchRepository.update(batch);
      actions.push('unblocked');
      this.publishEvent(batch, {
        type: 'release_batch.unblocked',
        level: 'info',
        message: `release-batch ${batch.id} unblocked: PR #${prNumber} blocker resolved`,
        timestamp: now,
        metadata: {
          releaseBatchId: batch.id,
          position,
          issueNumber: currentItem.issueNumber,
          runUuid: currentItem.runUuid,
          prNumber,
        },
      });
    }

    // 5. Merged Check
    if (readiness.isMerged || readiness.state === 'merged') {
      let mergedSha = readiness.mergeCommitSha;
      const r = this.deps.repositoryPort.findById(batch.repoId);
      if (this.deps.git && r) {
        try {
          await this.deps.git.fetch(r.localBasePath, 'origin', batch.releaseBranch);
          const remoteSha = await this.deps.git.resolveRef(
            r.localBasePath,
            `origin/${batch.releaseBranch}`,
          );
          if (remoteSha) {
            mergedSha = remoteSha;
          }
        } catch (err) {
          this.deps.logger?.warn?.(
            `Failed to fetch origin/${batch.releaseBranch}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      if (!mergedSha) {
        mergedSha = readiness.mergeCommitSha ?? 'unknown-merge-sha';
      }

      const certifyResult = await this.certifyItemMerged({
        batchId: batch.id,
        position,
        mergedCommitSha: mergedSha,
        now,
      });
      return { batch: certifyResult.batch, actions, certifyResult };
    }

    // 6. Open / Pending CI / Merge Check
    if (readiness.state === 'open') {
      const updatedItem = batch.items.find((i) => i.position === position);
      if (updatedItem && updatedItem.status === 'active') {
        batch = markItemWaitingMerge(batch, position, prNumber);
        this.deps.releaseBatchRepository.update(batch);
        actions.push('pr_attached');
        this.publishEvent(batch, {
          type: 'release_batch.item_waiting_merge',
          level: 'info',
          message: `release-batch ${batch.id} item #${updatedItem.issueNumber} waiting merge on PR #${prNumber}`,
          timestamp: now,
          metadata: {
            releaseBatchId: batch.id,
            position,
            issueNumber: updatedItem.issueNumber,
            runUuid: updatedItem.runUuid,
            prNumber,
          },
        });
      }
    }

    return { batch, actions };
  }

  private publishEvent(
    batch: ReleaseBatch,
    event: {
      type: string;
      level: 'info' | 'warn' | 'error';
      message: string;
      timestamp: Date;
      metadata: Record<string, unknown>;
    },
  ): void {
    const runUuid = (event.metadata['runUuid'] as string | undefined) ?? batch.id;
    const runDisplayId =
      (event.metadata['runDisplayId'] as string | undefined) ?? `batch-${batch.id}`;

    const eventPayload = {
      runId: runDisplayId,
      level: event.level,
      type: event.type,
      message: event.message,
      timestamp: event.timestamp.toISOString(),
      metadata: event.metadata,
    };

    try {
      this.deps.eventBus.publish(runUuid, eventPayload);
    } catch (err) {
      this.deps.logger?.error?.(`Failed to publish event for release batch ${batch.id}`, err);
    }

    const eventRepo: EventRepositoryPort | undefined =
      typeof this.deps.eventRepository === 'function'
        ? this.deps.eventRepository(batch.repoId)
        : this.deps.eventRepository;

    if (eventRepo) {
      try {
        eventRepo.insert({
          runUuid,
          level: eventPayload.level,
          type: eventPayload.type,
          message: eventPayload.message,
          metadata: eventPayload.metadata,
          timestamp: event.timestamp,
        });
      } catch (err) {
        this.deps.logger?.error?.(`Failed to record event for release batch ${batch.id}`, err);
      }
    }
  }
}

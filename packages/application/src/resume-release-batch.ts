import {
  ReleaseBatchStateError,
  type ReleaseBatchId,
  type RepositoryId,
  type Repository,
  type ReleaseBatch,
} from '@ai-sdlc/domain';
import type { ReleaseBatchRepositoryPort, RunRepositoryPort } from './ports.js';
import type { ReleaseBatchCoordinator, ReconciliationAction } from './release-batch-coordinator.js';
import {
  classifyReleaseBatchBlocker,
  type ReleaseBatchBlockerInfo,
} from './blocker-classification.js';

export class RunOwnedBlockerError extends ReleaseBatchStateError {
  constructor(
    message: string,
    public readonly batchId: string,
    public readonly runUuid: string,
    public readonly issueNumber?: number,
    public readonly runStatus?: string,
    public readonly runPhase?: string,
  ) {
    super(message);
    this.name = 'RunOwnedBlockerError';
    Object.setPrototypeOf(this, RunOwnedBlockerError.prototype);
  }
}

export interface ResumeReleaseBatchInput {
  batchId: ReleaseBatchId;
  confirm?: boolean;
}

export interface ResumeReleaseBatchResult {
  batchId: ReleaseBatchId;
  batch: ReleaseBatch;
  actions: ReconciliationAction[];
  blocker: ReleaseBatchBlockerInfo;
}

export interface ResumeReleaseBatchDeps {
  releaseBatchRepository: ReleaseBatchRepositoryPort;
  runRepository: RunRepositoryPort;
  coordinator: ReleaseBatchCoordinator;
  repositoryPort?: {
    findById(id: RepositoryId): Repository | undefined;
  };
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
  };
}

export class ResumeReleaseBatch {
  constructor(private readonly deps: ResumeReleaseBatchDeps) {}

  async execute(input: ResumeReleaseBatchInput): Promise<ResumeReleaseBatchResult> {
    const batch = this.deps.releaseBatchRepository.findById(input.batchId);
    if (!batch) {
      throw new ReleaseBatchStateError(`ReleaseBatch ${input.batchId} not found`);
    }

    if (batch.status === 'completed' || batch.status === 'cancelled') {
      throw new ReleaseBatchStateError(
        `Cannot resume ReleaseBatch ${input.batchId} because it is in terminal state '${batch.status}'`,
      );
    }

    // Inspect current item and run
    const currentItem =
      batch.items.find((i) => i.status === 'blocked' || i.status === 'active') ??
      batch.items.find((i) => i.position === batch.currentPosition);

    const currentRun = currentItem?.runUuid
      ? this.deps.runRepository.findByUuid(currentItem.runUuid)
      : undefined;

    // Check blocker ownership
    const blocker = classifyReleaseBatchBlocker(batch, currentRun);

    if (blocker.owner === 'run') {
      const runUuid = blocker.runUuid ?? currentItem?.runUuid ?? 'unknown';
      const issueNumber = blocker.issueNumber ?? currentItem?.issueNumber;
      const runStatus =
        blocker.runStatus ?? (currentRun as { status?: string } | undefined)?.status ?? 'unknown';
      const rawPhase = currentRun as { currentPhase?: string | null; phase?: string } | undefined;
      const runPhase = blocker.runPhase ?? rawPhase?.currentPhase ?? rawPhase?.phase ?? undefined;
      throw new RunOwnedBlockerError(
        `Release batch ${batch.id}${issueNumber !== undefined ? ` item #${issueNumber}` : ''} is blocked by run ${runUuid} (${runStatus}${runPhase ? ` / ${runPhase}` : ''}).\nRun recovery must be performed via Run CLI:\n  runs resume --uuid ${runUuid}`,
        batch.id,
        runUuid,
        issueNumber,
        runStatus,
        runPhase,
      );
    }

    const actions: ReconciliationAction[] = [];

    // If blocked on source_branch_advanced, integrate source changes
    if (batch.status === 'blocked' && batch.blockedReason === 'source_branch_advanced') {
      const integrationResult = await this.deps.coordinator.integrateSourceBranch(batch.id);
      if (integrationResult.success) {
        actions.push('source_drift_integrated');
      }
    }

    // Reconcile batch with coordinator
    const reconcileResult = await this.deps.coordinator.reconcile(batch.id);
    actions.push(...reconcileResult.actions);

    const updatedBatch =
      this.deps.releaseBatchRepository.findById(batch.id) ?? reconcileResult.batch;
    const updatedBlocker = classifyReleaseBatchBlocker(updatedBatch);

    return {
      batchId: batch.id,
      batch: updatedBatch,
      actions,
      blocker: updatedBlocker,
    };
  }
}

import {
  type ReleaseBatch,
  type ReleaseBatchId,
  type RepositoryId,
  type Repository,
  approveBatchCandidate,
  rejectBatchCandidate,
  appendRemediationItems,
  attachPromotionPr,
  ReleaseBatchStateError,
  SourceBranchDriftError,
  ReleaseBranchDriftError,
  RemediationNotAllowedError,
} from '@ai-sdlc/domain';
import type {
  ReleaseBatchRepositoryPort,
  GitPort,
  GitHubPort,
  EventBusPort,
  EventRepositoryPort,
  MergeMethod,
} from './ports.js';
import type { EventRepositoryFactory } from './start-issue-run.js';
import type { ReleaseBatchCoordinator } from './release-batch-coordinator.js';

export interface ManualTestGateDeps {
  releaseBatchRepository: ReleaseBatchRepositoryPort;
  repositoryPort?:
    | {
        findById(id: RepositoryId): Repository | undefined;
      }
    | undefined;
  git?: GitPort | undefined;
  github?: GitHubPort | undefined;
  eventBus?: EventBusPort | undefined;
  eventRepository?: EventRepositoryPort | EventRepositoryFactory | undefined;
  coordinator?: ReleaseBatchCoordinator | undefined;
  now?: (() => Date) | undefined;
  logger?:
    | {
        info?: (msg: string) => void;
        warn?: (msg: string) => void;
        error?: (msg: string, err?: unknown) => void;
      }
    | undefined;
}

export class ApproveReleaseBatchCandidate {
  constructor(private readonly deps: ManualTestGateDeps) {}

  async execute(input: {
    batchId: ReleaseBatchId;
    candidateSha: string;
    operator?: string;
  }): Promise<ReleaseBatch> {
    const now = (this.deps.now ?? (() => new Date()))();
    const batch = this.deps.releaseBatchRepository.findById(input.batchId);
    if (!batch) {
      throw new ReleaseBatchStateError(`ReleaseBatch ${input.batchId} not found`);
    }

    if (batch.status !== 'awaiting_manual_test') {
      throw new ReleaseBatchStateError(
        `cannot approve candidate: batch status is '${batch.status}', expected 'awaiting_manual_test'`,
      );
    }

    if (!batch.candidateSha || input.candidateSha !== batch.candidateSha) {
      throw new ReleaseBatchStateError(
        `cannot approve candidate: candidateSha '${input.candidateSha}' does not match batch candidateSha '${batch.candidateSha}'`,
      );
    }

    const repo = this.deps.repositoryPort?.findById(batch.repoId);
    if (this.deps.git && repo) {
      await this.deps.git.fetch(repo.localBasePath, 'origin', batch.releaseBranch);
      await this.deps.git.fetch(repo.localBasePath, 'origin', batch.sourceBranch);

      const remoteReleaseSha = await this.deps.git.resolveRef(
        repo.localBasePath,
        `origin/${batch.releaseBranch}`,
      );
      if (remoteReleaseSha && remoteReleaseSha !== batch.candidateSha) {
        throw new ReleaseBranchDriftError(
          `release branch moved from candidate SHA ${batch.candidateSha} to ${remoteReleaseSha}`,
        );
      }

      const remoteSourceSha = await this.deps.git.resolveRef(
        repo.localBasePath,
        `origin/${batch.sourceBranch}`,
      );
      if (remoteSourceSha) {
        const isContained = await this.deps.git.isAncestor(
          repo.localBasePath,
          remoteSourceSha,
          batch.candidateSha,
        );
        if (!isContained) {
          throw new SourceBranchDriftError(
            `source branch advanced beyond candidate SHA ${batch.candidateSha}`,
          );
        }
      }
    }

    const approved = approveBatchCandidate(batch, input.candidateSha);
    this.deps.releaseBatchRepository.update(approved);

    this.publishEvent(approved, {
      type: 'release_batch.candidate_approved',
      level: 'info',
      message: `release-batch ${approved.id} candidate ${input.candidateSha} approved${input.operator ? ` by ${input.operator}` : ''}`,
      timestamp: now,
      metadata: {
        releaseBatchId: approved.id,
        candidateSha: input.candidateSha,
        ...(input.operator ? { operator: input.operator } : {}),
      },
    });

    return approved;
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
    publishBatchEvent(this.deps, batch, event);
  }
}

export class RejectReleaseBatchCandidate {
  constructor(private readonly deps: ManualTestGateDeps) {}

  async execute(input: {
    batchId: ReleaseBatchId;
    candidateSha: string;
    reason?: string;
    operator?: string;
  }): Promise<ReleaseBatch> {
    const now = (this.deps.now ?? (() => new Date()))();
    const batch = this.deps.releaseBatchRepository.findById(input.batchId);
    if (!batch) {
      throw new ReleaseBatchStateError(`ReleaseBatch ${input.batchId} not found`);
    }

    if (batch.status !== 'awaiting_manual_test') {
      throw new ReleaseBatchStateError(
        `cannot reject candidate: batch status is '${batch.status}', expected 'awaiting_manual_test'`,
      );
    }

    const rejected = rejectBatchCandidate(batch, {
      candidateSha: input.candidateSha,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    this.deps.releaseBatchRepository.update(rejected);

    this.publishEvent(rejected, {
      type: 'release_batch.candidate_rejected',
      level: 'warn',
      message: `release-batch ${rejected.id} candidate ${input.candidateSha} rejected${input.operator ? ` by ${input.operator}` : ''}${input.reason ? `: ${input.reason}` : ''}`,
      timestamp: now,
      metadata: {
        releaseBatchId: rejected.id,
        candidateSha: input.candidateSha,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.operator ? { operator: input.operator } : {}),
      },
    });

    return rejected;
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
    publishBatchEvent(this.deps, batch, event);
  }
}

export class AppendRemediationIssues {
  constructor(private readonly deps: ManualTestGateDeps) {}

  async execute(input: { batchId: ReleaseBatchId; issueNumbers: number[] }): Promise<ReleaseBatch> {
    const now = (this.deps.now ?? (() => new Date()))();
    const batch = this.deps.releaseBatchRepository.findById(input.batchId);
    if (!batch) {
      throw new ReleaseBatchStateError(`ReleaseBatch ${input.batchId} not found`);
    }

    if (batch.status !== 'test_failed') {
      throw new RemediationNotAllowedError(
        `cannot append remediation issues: batch status is '${batch.status}', expected 'test_failed'`,
      );
    }

    const repo = this.deps.repositoryPort?.findById(batch.repoId);
    if (this.deps.github && repo) {
      for (const num of input.issueNumbers) {
        try {
          const issue = await this.deps.github.getIssue(repo.fullName, num);
          if (issue.state !== 'open') {
            throw new ReleaseBatchStateError(
              `remediation issue #${num} is closed in repository ${repo.fullName}`,
            );
          }
        } catch (err) {
          if (err instanceof ReleaseBatchStateError) throw err;
          throw new ReleaseBatchStateError(
            `remediation issue #${num} not found in repository ${repo.fullName}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    const updated = appendRemediationItems(batch, input.issueNumbers);
    this.deps.releaseBatchRepository.update(updated);

    this.publishEvent(updated, {
      type: 'release_batch.remediation_appended',
      level: 'info',
      message: `release-batch ${updated.id} appended ${input.issueNumbers.length} remediation issues (${input.issueNumbers.join(', ')})`,
      timestamp: now,
      metadata: {
        releaseBatchId: updated.id,
        issueNumbers: input.issueNumbers,
        newTotalItems: updated.items.length,
      },
    });

    if (this.deps.coordinator) {
      await this.deps.coordinator.reconcile(updated.id);
      return this.deps.releaseBatchRepository.findById(updated.id) ?? updated;
    }

    return updated;
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
    publishBatchEvent(this.deps, batch, event);
  }
}

export class PromoteReleaseBatch {
  constructor(private readonly deps: ManualTestGateDeps) {}

  async execute(input: {
    batchId: ReleaseBatchId;
    mergeMethod?: MergeMethod;
    autoMerge?: boolean;
  }): Promise<{ batch: ReleaseBatch; prNumber: number }> {
    const now = (this.deps.now ?? (() => new Date()))();
    let batch = this.deps.releaseBatchRepository.findById(input.batchId);
    if (!batch) {
      throw new ReleaseBatchStateError(`ReleaseBatch ${input.batchId} not found`);
    }

    if (batch.status !== 'approved' && batch.status !== 'promoting') {
      throw new ReleaseBatchStateError(
        `cannot promote release batch: status is '${batch.status}', expected 'approved' or 'promoting'`,
      );
    }

    if (!batch.approvedCandidateSha || batch.approvedCandidateSha !== batch.candidateSha) {
      throw new ReleaseBatchStateError(
        'cannot promote release batch: approved candidate SHA is missing or does not match candidate SHA',
      );
    }

    const repo = this.deps.repositoryPort?.findById(batch.repoId);
    if (!repo) {
      throw new ReleaseBatchStateError(`Repository ${batch.repoId} not found`);
    }

    // Branch drift and item ancestry verification
    if (this.deps.git) {
      await this.deps.git.fetch(repo.localBasePath, 'origin', batch.releaseBranch);
      await this.deps.git.fetch(repo.localBasePath, 'origin', batch.sourceBranch);

      const remoteReleaseSha = await this.deps.git.resolveRef(
        repo.localBasePath,
        `origin/${batch.releaseBranch}`,
      );
      if (remoteReleaseSha && remoteReleaseSha !== batch.approvedCandidateSha) {
        throw new ReleaseBranchDriftError(
          `release branch moved from approved candidate SHA ${batch.approvedCandidateSha} to ${remoteReleaseSha}`,
        );
      }

      const remoteSourceSha = await this.deps.git.resolveRef(
        repo.localBasePath,
        `origin/${batch.sourceBranch}`,
      );
      if (remoteSourceSha) {
        const isContained = await this.deps.git.isAncestor(
          repo.localBasePath,
          remoteSourceSha,
          batch.approvedCandidateSha,
        );
        if (!isContained) {
          throw new SourceBranchDriftError(
            `source branch advanced beyond approved candidate SHA ${batch.approvedCandidateSha}`,
          );
        }
      }

      // Verify all merged items are in approvedCandidateSha ancestry
      for (const item of batch.items) {
        if (item.mergedCommitSha) {
          const itemInCandidate = await this.deps.git.isAncestor(
            repo.localBasePath,
            item.mergedCommitSha,
            batch.approvedCandidateSha,
          );
          if (!itemInCandidate) {
            throw new ReleaseBatchStateError(
              `approved candidate ${batch.approvedCandidateSha} does not contain item #${item.issueNumber} merge commit ${item.mergedCommitSha}`,
            );
          }
        }
      }
    }

    let prNumber = batch.promotionPrNumber;
    if (!prNumber && this.deps.github) {
      const pr = await this.deps.github.createPullRequest({
        repoFullName: repo.fullName,
        headBranch: batch.releaseBranch,
        baseBranch: batch.sourceBranch,
        title: `Release ${batch.id}: ${batch.items.map((i) => `#${i.issueNumber}`).join(', ')}`,
        body: `Autonomous release batch promotion for ${batch.id}.\nApproved Candidate SHA: \`${batch.approvedCandidateSha}\``,
      });
      prNumber = pr.number;
      batch = attachPromotionPr(batch, prNumber);
      this.deps.releaseBatchRepository.update(batch);

      this.publishEvent(batch, {
        type: 'release_batch.promoting',
        level: 'info',
        message: `release-batch ${batch.id} created promotion PR #${prNumber} to ${batch.sourceBranch}`,
        timestamp: now,
        metadata: {
          releaseBatchId: batch.id,
          prNumber,
          releaseBranch: batch.releaseBranch,
          sourceBranch: batch.sourceBranch,
          approvedCandidateSha: batch.approvedCandidateSha,
        },
      });

      // Request auto-merge
      if (input.autoMerge !== false) {
        try {
          await this.deps.github.requestAutoMerge(
            repo.fullName,
            prNumber,
            input.mergeMethod ?? 'merge',
          );
        } catch (err) {
          this.deps.logger?.warn?.(
            `Failed to request auto-merge for promotion PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // If coordinator is provided, trigger reconciliation to check PR merge readiness
    if (this.deps.coordinator) {
      await this.deps.coordinator.reconcile(batch.id);
      batch = this.deps.releaseBatchRepository.findById(batch.id) ?? batch;
    }

    return { batch, prNumber: prNumber ?? 0 };
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
    publishBatchEvent(this.deps, batch, event);
  }
}

function publishBatchEvent(
  deps: ManualTestGateDeps,
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

  const payload = {
    runId: runDisplayId,
    level: event.level,
    type: event.type,
    message: event.message,
    timestamp: event.timestamp.toISOString(),
    metadata: event.metadata,
  };

  if (!deps.eventBus) return;

  try {
    deps.eventBus.publish(runUuid, payload);
  } catch (err) {
    deps.logger?.error?.(`Failed to publish event for release batch ${batch.id}`, err);
  }

  const eventRepo: EventRepositoryPort | undefined =
    typeof deps.eventRepository === 'function'
      ? deps.eventRepository(batch.repoId)
      : deps.eventRepository;

  if (eventRepo) {
    try {
      eventRepo.insert({
        runUuid,
        level: payload.level,
        type: payload.type,
        message: payload.message,
        metadata: payload.metadata,
        timestamp: event.timestamp,
      });
    } catch (err) {
      deps.logger?.error?.(`Failed to record event for release batch ${batch.id}`, err);
    }
  }
}

import type { ReleaseBatchId, RepositoryId, Repository, Run } from '@ai-sdlc/domain';
import { ReleaseBatchStateError } from '@ai-sdlc/domain';
import type {
  ReleaseBatchRepositoryPort,
  RunRepositoryPort,
  GitPort,
  GitHubPort,
} from './ports.js';
import {
  classifyReleaseBatchBlocker,
  type ReleaseBatchBlockerInfo,
} from './blocker-classification.js';

export interface ReleaseBatchItemStatusView {
  position: number;
  issueNumber: number;
  status: string;
  runUuid?: string;
  prNumber?: number;
  baseSha?: string;
  mergedCommitSha?: string;
  blockedReason?: string;
  runPhase?: string;
  runStatus?: string;
}

export interface ReleaseBatchStatusView {
  id: ReleaseBatchId;
  status: string;
  repoId: RepositoryId;
  repoFullName?: string;
  sourceBranch: string;
  sourceStartSha: string;
  currentSourceSha?: string;
  releaseBranch: string;
  currentReleaseSha?: string;
  items: ReleaseBatchItemStatusView[];
  currentItem?: {
    position: number;
    issueNumber: number;
    status: string;
    runUuid?: string;
    currentPhase?: string;
    runStatus?: string;
    prNumber?: number;
    prMergeState?: string;
  };
  blocker: ReleaseBatchBlockerInfo;
  candidate: {
    candidateSha?: string;
    approvedCandidateSha?: string;
    candidateTreeSha?: string;
    isStale: boolean;
  };
  manualTesting: {
    status: 'required' | 'stale' | 'approved' | 'rejected' | 'completed' | 'not_ready';
    candidateSha?: string;
    note?: string;
  };
  promotion?: {
    prNumber?: number;
    commitSha?: string;
    status: 'none' | 'promoting' | 'merged' | 'blocked';
  };
  formattedLines: string[];
}

export interface GetReleaseBatchStatusDeps {
  releaseBatchRepository: ReleaseBatchRepositoryPort;
  runRepository: RunRepositoryPort;
  repositoryPort?: {
    findById(id: RepositoryId): Repository | undefined;
  };
  git?: GitPort;
  github?: GitHubPort;
  logger?: { warn: (msg: string) => void };
}

export class GetReleaseBatchStatus {
  constructor(private readonly deps: GetReleaseBatchStatusDeps) {}

  async execute(input: { batchId: ReleaseBatchId }): Promise<ReleaseBatchStatusView> {
    const batch = this.deps.releaseBatchRepository.findById(input.batchId);
    if (!batch) {
      throw new ReleaseBatchStateError(`ReleaseBatch ${input.batchId} not found`);
    }

    const repo = this.deps.repositoryPort?.findById(batch.repoId);

    // Resolve current remote SHAs if git is available
    let currentSourceSha: string | undefined;
    let currentReleaseSha: string | undefined;

    if (this.deps.git && repo) {
      try {
        await this.deps.git.fetch(repo.localBasePath, 'origin', batch.sourceBranch);
        currentSourceSha = await this.deps.git.resolveRef(
          repo.localBasePath,
          `origin/${batch.sourceBranch}`,
        );
      } catch (err) {
        this.deps.logger?.warn?.(
          `Failed to resolve current source branch SHA: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        await this.deps.git.fetch(repo.localBasePath, 'origin', batch.releaseBranch);
        currentReleaseSha = await this.deps.git.resolveRef(
          repo.localBasePath,
          `origin/${batch.releaseBranch}`,
        );
      } catch (err) {
        this.deps.logger?.warn?.(
          `Failed to resolve current release branch SHA: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Inspect items and find current Run
    let currentItemRun: Run | undefined;
    const itemsView: ReleaseBatchItemStatusView[] = batch.items.map((item) => {
      let runPhase: string | undefined;
      let runStatus: string | undefined;

      if (item.runUuid) {
        const run = this.deps.runRepository.findByUuid(item.runUuid);
        if (run) {
          runPhase = run.currentPhase ?? undefined;
          runStatus = run.status;
          if (item.position === batch.currentPosition || item.status === 'active') {
            currentItemRun = run;
          }
        }
      }

      return {
        position: item.position,
        issueNumber: item.issueNumber,
        status: item.status,
        ...(item.runUuid ? { runUuid: item.runUuid } : {}),
        ...(item.prNumber ? { prNumber: item.prNumber } : {}),
        ...(item.baseSha ? { baseSha: item.baseSha } : {}),
        ...(item.mergedCommitSha ? { mergedCommitSha: item.mergedCommitSha } : {}),
        ...(item.blockedReason ? { blockedReason: item.blockedReason } : {}),
        ...(runPhase ? { runPhase } : {}),
        ...(runStatus ? { runStatus } : {}),
      };
    });

    // Determine current item
    const currentItemRecord =
      batch.items.find((i) => i.status === 'blocked' || i.status === 'active') ??
      batch.items.find((i) => i.position === batch.currentPosition);

    let currentItemView: ReleaseBatchStatusView['currentItem'];
    if (currentItemRecord) {
      let prMergeState: string | undefined;
      if (currentItemRecord.prNumber && this.deps.github && repo) {
        try {
          const readiness = await this.deps.github.getPrMergeReadiness(
            repo.fullName,
            currentItemRecord.prNumber,
          );
          prMergeState = readiness.isMerged ? 'merged' : readiness.state;
        } catch {
          // Keep undefined if github unavailable
        }
      }

      currentItemView = {
        position: currentItemRecord.position,
        issueNumber: currentItemRecord.issueNumber,
        status: currentItemRecord.status,
        ...(currentItemRecord.runUuid ? { runUuid: currentItemRecord.runUuid } : {}),
        ...(currentItemRun?.currentPhase ? { currentPhase: currentItemRun.currentPhase } : {}),
        ...(currentItemRun?.status ? { runStatus: currentItemRun.status } : {}),
        ...(currentItemRecord.prNumber ? { prNumber: currentItemRecord.prNumber } : {}),
        ...(prMergeState ? { prMergeState } : {}),
      };
    }

    // Blocker analysis
    const blocker = classifyReleaseBatchBlocker(batch, currentItemRun);

    // Candidate staleness check
    let isStale = false;
    if (batch.candidateSha) {
      if (
        batch.blockedReason === 'source_branch_advanced' ||
        batch.blockedReason === 'release_branch_drift'
      ) {
        isStale = true;
      } else if (currentReleaseSha && currentReleaseSha !== batch.candidateSha) {
        isStale = true;
      }
    }

    // Manual testing state
    let manualTestingStatus: ReleaseBatchStatusView['manualTesting']['status'] = 'not_ready';
    let manualTestingNote: string | undefined;

    if (batch.status === 'completed') {
      manualTestingStatus = 'completed';
      manualTestingNote = 'Release batch already promoted and completed';
    } else if (batch.status === 'approved') {
      if (isStale) {
        manualTestingStatus = 'stale';
        manualTestingNote = 'Source or release drift detected after approval; retest required';
      } else {
        manualTestingStatus = 'approved';
        manualTestingNote = `Approved candidate ${batch.approvedCandidateSha ?? batch.candidateSha}`;
      }
    } else if (batch.status === 'test_failed') {
      manualTestingStatus = 'rejected';
      manualTestingNote = batch.blockedReason ?? 'Manual exploratory testing rejected candidate';
    } else if (batch.status === 'awaiting_manual_test') {
      if (isStale) {
        manualTestingStatus = 'stale';
        manualTestingNote = 'Candidate is stale due to branch drift; integration + retest required';
      } else {
        manualTestingStatus = 'required';
        manualTestingNote = `Candidate ${batch.candidateSha} ready for manual verification`;
      }
    }

    // Promotion state
    let promotionStatus: ReleaseBatchStatusView['promotion'] = undefined;
    if (batch.promotionPrNumber || batch.status === 'promoting' || batch.status === 'completed') {
      let pStatus: 'none' | 'promoting' | 'merged' | 'blocked' = 'none';
      if (batch.status === 'completed') {
        pStatus = 'merged';
      } else if (batch.status === 'blocked' && batch.blockedReason?.startsWith('promotion_')) {
        pStatus = 'blocked';
      } else if (batch.status === 'promoting') {
        pStatus = 'promoting';
      }

      promotionStatus = {
        ...(batch.promotionPrNumber ? { prNumber: batch.promotionPrNumber } : {}),
        ...(batch.promotionCommitSha ? { commitSha: batch.promotionCommitSha } : {}),
        status: pStatus,
      };
    }

    // Format human-readable console lines
    const lines: string[] = [];
    lines.push(`ReleaseBatch:     ${batch.id}`);
    lines.push(`Status:           ${batch.status}`);
    lines.push(`Repository:       ${repo ? repo.fullName : batch.repoId}`);
    lines.push(
      `Source Branch:    ${batch.sourceBranch} (start: ${batch.sourceStartSha.slice(0, 8)}, current: ${currentSourceSha ? currentSourceSha.slice(0, 8) : 'unknown'})`,
    );
    lines.push(
      `Release Branch:   ${batch.releaseBranch} (current: ${currentReleaseSha ? currentReleaseSha.slice(0, 8) : 'unknown'})`,
    );

    lines.push('\nOrdered Issues:');
    for (const item of itemsView) {
      const parts = [
        `  ${item.position}. #${item.issueNumber} [${item.status}]`,
        item.runUuid ? `run=${item.runUuid}` : null,
        item.runPhase ? `phase=${item.runPhase}` : null,
        item.prNumber ? `pr=#${item.prNumber}` : null,
        item.mergedCommitSha ? `merged=${item.mergedCommitSha.slice(0, 8)}` : null,
        item.blockedReason ? `blocked=(${item.blockedReason})` : null,
      ].filter(Boolean);
      lines.push(parts.join(' | '));
    }

    if (currentItemView) {
      lines.push('\nCurrent Item:');
      lines.push(
        `  Position ${currentItemView.position}: #${currentItemView.issueNumber} [${currentItemView.status}]`,
      );
      if (currentItemView.runUuid) {
        lines.push(`  Run UUID:       ${currentItemView.runUuid}`);
        lines.push(`  Run Phase:      ${currentItemView.currentPhase ?? 'unknown'}`);
        lines.push(`  Run Status:     ${currentItemView.runStatus ?? 'unknown'}`);
      }
      if (currentItemView.prNumber) {
        lines.push(
          `  PR Number:      #${currentItemView.prNumber} (${currentItemView.prMergeState ?? 'open'})`,
        );
      }
    }

    lines.push('\nBlocker Diagnostics:');
    lines.push(`  Owner:          ${blocker.owner}`);
    if (blocker.owner !== 'none') {
      lines.push(`  Reason:         ${blocker.reason ?? 'none'}`);
      if (blocker.runUuid) lines.push(`  Run UUID:       ${blocker.runUuid}`);
      if (blocker.action) lines.push(`  Action:         ${blocker.action}`);
    } else {
      lines.push('  Reason:         none (batch is not blocked)');
    }

    lines.push('\nRelease Candidate & Manual Test:');
    lines.push(`  Candidate SHA:  ${batch.candidateSha ?? 'none'}`);
    lines.push(`  Approved SHA:   ${batch.approvedCandidateSha ?? 'none'}`);
    lines.push(`  Candidate Stale:${isStale ? ' YES (source/release branch drifted)' : ' no'}`);
    lines.push(`  Manual Testing: ${manualTestingStatus} - ${manualTestingNote ?? ''}`);

    if (promotionStatus) {
      lines.push('\nPromotion:');
      lines.push(`  Status:         ${promotionStatus.status}`);
      if (promotionStatus.prNumber) lines.push(`  Promotion PR:   #${promotionStatus.prNumber}`);
      if (promotionStatus.commitSha) lines.push(`  Promotion SHA:  ${promotionStatus.commitSha}`);
    }

    return {
      id: batch.id,
      status: batch.status,
      repoId: batch.repoId,
      ...(repo ? { repoFullName: repo.fullName } : {}),
      sourceBranch: batch.sourceBranch,
      sourceStartSha: batch.sourceStartSha,
      ...(currentSourceSha ? { currentSourceSha } : {}),
      releaseBranch: batch.releaseBranch,
      ...(currentReleaseSha ? { currentReleaseSha } : {}),
      items: itemsView,
      ...(currentItemView ? { currentItem: currentItemView } : {}),
      blocker,
      candidate: {
        ...(batch.candidateSha ? { candidateSha: batch.candidateSha } : {}),
        ...(batch.approvedCandidateSha ? { approvedCandidateSha: batch.approvedCandidateSha } : {}),
        ...(batch.candidateTreeSha ? { candidateTreeSha: batch.candidateTreeSha } : {}),
        isStale,
      },
      manualTesting: {
        status: manualTestingStatus,
        ...(batch.candidateSha ? { candidateSha: batch.candidateSha } : {}),
        ...(manualTestingNote ? { note: manualTestingNote } : {}),
      },
      ...(promotionStatus ? { promotion: promotionStatus } : {}),
      formattedLines: lines,
    };
  }
}

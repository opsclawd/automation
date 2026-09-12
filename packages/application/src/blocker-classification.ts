import type { ReleaseBatch, ReleaseBatchItem, Run } from '@ai-sdlc/domain';

export type ReleaseBatchBlockerOwner = 'none' | 'run' | 'release' | 'github' | 'environment';

export interface ReleaseBatchBlockerInfo {
  owner: ReleaseBatchBlockerOwner;
  reason?: string;
  action?: string;
  runUuid?: string;
  issueNumber?: number;
  position?: number;
  runStatus?: string;
  runPhase?: string;
}

const RUN_BLOCKER_REASONS = new Set([
  'run_failed',
  'run_blocked',
  'run_cancelled',
  'needs_human_review',
]);

export function classifyReleaseBatchBlocker(
  batch: ReleaseBatch,
  currentRun?: Run | null,
): ReleaseBatchBlockerInfo {
  const currentItem: ReleaseBatchItem | undefined =
    batch.items.find((i) => i.status === 'blocked' || i.status === 'active') ??
    batch.items.find((i) => i.position === batch.currentPosition);

  // 1. Check if Run owns the blocker
  const batchReason = batch.blockedReason ?? '';
  const itemReason = currentItem?.blockedReason ?? '';
  const effectiveReason = batchReason || itemReason;

  const isRunReason =
    RUN_BLOCKER_REASONS.has(batchReason) ||
    RUN_BLOCKER_REASONS.has(itemReason) ||
    batchReason.startsWith('run_') ||
    itemReason.startsWith('run_');

  const isRunTerminal =
    currentRun &&
    (currentRun.status === 'failed' ||
      currentRun.status === 'blocked' ||
      currentRun.status === 'cancelled' ||
      currentRun.status === 'needs_human_review');

  if (isRunReason || isRunTerminal) {
    const runUuid = currentItem?.runUuid ?? currentRun?.uuid;
    const issueNumber = currentItem?.issueNumber ?? currentRun?.issueNumber;
    const reason =
      effectiveReason || (currentRun ? `run_${currentRun.status}` : 'run_requires_recovery');
    const runStatus =
      (currentRun as { status?: string } | undefined)?.status ??
      (isRunReason ? batchReason || itemReason : undefined);
    const rawPhase = currentRun as { currentPhase?: string | null; phase?: string } | undefined;
    const runPhase = rawPhase?.currentPhase ?? rawPhase?.phase ?? undefined;

    return {
      owner: 'run',
      reason,
      ...(runUuid !== undefined ? { runUuid } : {}),
      ...(issueNumber !== undefined ? { issueNumber } : {}),
      ...(currentItem?.position !== undefined ? { position: currentItem.position } : {}),
      ...(runStatus !== undefined ? { runStatus } : {}),
      ...(runPhase !== undefined ? { runPhase } : {}),
      action: runUuid
        ? `Blocker is owned by Run ${runUuid} (issue #${issueNumber ?? '?'}). Recovery must be performed via Run recovery: runs resume --uuid ${runUuid}`
        : 'Blocker is owned by Run. Recovery must be performed via runs resume.',
    };
  }

  // 2. If neither batch nor item is blocked, no blocker exists
  if (batch.status !== 'blocked' && currentItem?.status !== 'blocked') {
    return { owner: 'none' };
  }

  // 3. Environment-owned blockers
  if (
    effectiveReason === 'environment_unhealthy' ||
    effectiveReason.startsWith('Disk free space') ||
    effectiveReason.startsWith('Available memory') ||
    effectiveReason.toLowerCase().includes('maintenance')
  ) {
    return {
      owner: 'environment',
      reason: effectiveReason,
      ...(currentItem?.position !== undefined ? { position: currentItem.position } : {}),
      ...(currentItem?.issueNumber !== undefined ? { issueNumber: currentItem.issueNumber } : {}),
      action: `Environment resource threshold breached (${effectiveReason}). Free up disk/memory resources and resume via: releases resume --id ${batch.id}`,
    };
  }

  // 4. Release-owned blockers
  if (
    effectiveReason === 'source_branch_advanced' ||
    effectiveReason === 'release_branch_drift' ||
    effectiveReason === 'promotion_tree_mismatch'
  ) {
    let action = `Release branch or source branch drift detected (${effectiveReason}).`;
    if (effectiveReason === 'source_branch_advanced') {
      action = `Source branch ${batch.sourceBranch} advanced ahead of release branch. Integrate source changes via: releases integrate-source --id ${batch.id} (or releases resume --id ${batch.id})`;
    } else if (effectiveReason === 'release_branch_drift') {
      action = `Release branch ${batch.releaseBranch} changed after candidate capture. Retest required via: releases resume --id ${batch.id}`;
    } else if (effectiveReason === 'promotion_tree_mismatch') {
      action = `Promoted source branch content does not match approved candidate tree. Retest required.`;
    }

    return {
      owner: 'release',
      reason: effectiveReason,
      ...(currentItem?.position !== undefined ? { position: currentItem.position } : {}),
      ...(currentItem?.issueNumber !== undefined ? { issueNumber: currentItem.issueNumber } : {}),
      action,
    };
  }

  // 5. GitHub-owned blockers
  if (
    effectiveReason.startsWith('ci_failed') ||
    effectiveReason.startsWith('promotion_ci_failed') ||
    effectiveReason.startsWith('auto_merge_unavailable') ||
    effectiveReason.startsWith('pr_closed_unmerged') ||
    effectiveReason.startsWith('pr_base_mismatch')
  ) {
    let action = `GitHub check or configuration blocker (${effectiveReason}).`;
    if (effectiveReason.startsWith('ci_failed')) {
      action = `CI checks failed on GitHub PR. Resolve failing checks on GitHub, then resume via: releases resume --id ${batch.id}`;
    } else if (effectiveReason.startsWith('promotion_ci_failed')) {
      action = `CI checks failed on promotion PR #${batch.promotionPrNumber ?? ''}. Fix checks on GitHub, then resume via: releases resume --id ${batch.id}`;
    } else if (effectiveReason.startsWith('auto_merge_unavailable')) {
      action = `Auto-merge is disabled or unavailable on GitHub PR. Enable auto-merge on GitHub, then resume via: releases resume --id ${batch.id}`;
    } else if (effectiveReason.startsWith('pr_closed_unmerged')) {
      action = `PR was closed without merge. Re-open or fix on GitHub, then resume via: releases resume --id ${batch.id}`;
    } else if (effectiveReason.startsWith('pr_base_mismatch')) {
      action = `PR base branch does not target ${batch.releaseBranch}. Retarget PR on GitHub, then resume via: releases resume --id ${batch.id}`;
    }

    return {
      owner: 'github',
      reason: effectiveReason,
      ...(currentItem?.position !== undefined ? { position: currentItem.position } : {}),
      ...(currentItem?.issueNumber !== undefined ? { issueNumber: currentItem.issueNumber } : {}),
      action,
    };
  }

  // 6. Generic release-level blocker fallback
  return {
    owner: 'release',
    reason: effectiveReason || 'unknown_blocker',
    ...(currentItem?.position !== undefined ? { position: currentItem.position } : {}),
    ...(currentItem?.issueNumber !== undefined ? { issueNumber: currentItem.issueNumber } : {}),
    action: `Release batch is blocked (${effectiveReason || 'unknown'}). Reconcile via: releases resume --id ${batch.id}`,
  };
}

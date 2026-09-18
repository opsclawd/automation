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

  const isRunBlockerStatus =
    currentRun != null &&
    (currentRun.status === 'failed' ||
      currentRun.status === 'blocked' ||
      currentRun.status === 'cancelled' ||
      currentRun.status === 'needs_human_review');

  const isRunResolved =
    currentRun != null &&
    (currentRun.status === 'passed' ||
      currentRun.status === 'running' ||
      currentRun.status === 'queued' ||
      currentRun.status === 'waiting');

  // Run owns the blocker if currentRun is explicitly in a blocker status,
  // OR if currentRun is absent/unknown and the stored reason is a run blocker.
  if (isRunBlockerStatus || (!currentRun && isRunReason)) {
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

  // If the run has resolved, any historical run blocker reasons on the batch or item are stale.
  const isStaleRunReason = (r: string) => RUN_BLOCKER_REASONS.has(r) || r.startsWith('run_');
  const activeBatchReason = isRunResolved && isStaleRunReason(batchReason) ? '' : batchReason;
  const activeItemReason = isRunResolved && isStaleRunReason(itemReason) ? '' : itemReason;
  const activeEffectiveReason = activeBatchReason || activeItemReason;

  // 2. If neither batch nor item is blocked, or if the only block was a stale run blocker that has now resolved
  if (
    (batch.status !== 'blocked' && currentItem?.status !== 'blocked') ||
    (isRunResolved && !activeEffectiveReason)
  ) {
    return { owner: 'none' };
  }

  // 3. Environment-owned blockers
  if (
    activeEffectiveReason === 'environment_unhealthy' ||
    activeEffectiveReason.startsWith('Disk free space') ||
    activeEffectiveReason.startsWith('Available memory') ||
    activeEffectiveReason.toLowerCase().includes('maintenance')
  ) {
    return {
      owner: 'environment',
      reason: activeEffectiveReason,
      ...(currentItem?.position !== undefined ? { position: currentItem.position } : {}),
      ...(currentItem?.issueNumber !== undefined ? { issueNumber: currentItem.issueNumber } : {}),
      action: `Environment resource threshold breached (${activeEffectiveReason}). Free up disk/memory resources and resume via: releases resume --id ${batch.id}`,
    };
  }

  // 4. Release-owned blockers
  if (
    activeEffectiveReason === 'source_branch_advanced' ||
    activeEffectiveReason === 'release_branch_drift' ||
    activeEffectiveReason === 'promotion_tree_mismatch'
  ) {
    let action = `Release branch or source branch drift detected (${activeEffectiveReason}).`;
    if (activeEffectiveReason === 'source_branch_advanced') {
      action = `Source branch ${batch.sourceBranch} advanced ahead of release branch. Integrate source changes via: releases integrate-source --id ${batch.id} (or releases resume --id ${batch.id})`;
    } else if (activeEffectiveReason === 'release_branch_drift') {
      action = `Release branch ${batch.releaseBranch} changed after candidate capture. Retest required via: releases resume --id ${batch.id}`;
    } else if (activeEffectiveReason === 'promotion_tree_mismatch') {
      action = `Promoted source branch content does not match approved candidate tree. Retest required.`;
    }

    return {
      owner: 'release',
      reason: activeEffectiveReason,
      ...(currentItem?.position !== undefined ? { position: currentItem.position } : {}),
      ...(currentItem?.issueNumber !== undefined ? { issueNumber: currentItem.issueNumber } : {}),
      action,
    };
  }

  // 5. GitHub-owned blockers
  if (
    activeEffectiveReason.startsWith('ci_failed') ||
    activeEffectiveReason.startsWith('promotion_ci_failed') ||
    activeEffectiveReason.startsWith('auto_merge_unavailable') ||
    activeEffectiveReason.startsWith('pr_closed_unmerged') ||
    activeEffectiveReason.startsWith('pr_base_mismatch')
  ) {
    let action = `GitHub check or configuration blocker (${activeEffectiveReason}).`;
    if (activeEffectiveReason.startsWith('ci_failed')) {
      action = `CI checks failed on GitHub PR. Resolve failing checks on GitHub, then resume via: releases resume --id ${batch.id}`;
    } else if (activeEffectiveReason.startsWith('promotion_ci_failed')) {
      action = `CI checks failed on promotion PR #${batch.promotionPrNumber ?? ''}. Fix checks on GitHub, then resume via: releases resume --id ${batch.id}`;
    } else if (activeEffectiveReason.startsWith('auto_merge_unavailable')) {
      action = `Auto-merge is disabled or unavailable on GitHub PR. Enable auto-merge on GitHub, then resume via: releases resume --id ${batch.id}`;
    } else if (activeEffectiveReason.startsWith('pr_closed_unmerged')) {
      action = `PR was closed without merge. Re-open or fix on GitHub, then resume via: releases resume --id ${batch.id}`;
    } else if (activeEffectiveReason.startsWith('pr_base_mismatch')) {
      action = `PR base branch does not target ${batch.releaseBranch}. Retarget PR on GitHub, then resume via: releases resume --id ${batch.id}`;
    }

    return {
      owner: 'github',
      reason: activeEffectiveReason,
      ...(currentItem?.position !== undefined ? { position: currentItem.position } : {}),
      ...(currentItem?.issueNumber !== undefined ? { issueNumber: currentItem.issueNumber } : {}),
      action,
    };
  }

  // 6. Generic release-level blocker fallback
  return {
    owner: 'release',
    reason: activeEffectiveReason || 'unknown_blocker',
    ...(currentItem?.position !== undefined ? { position: currentItem.position } : {}),
    ...(currentItem?.issueNumber !== undefined ? { issueNumber: currentItem.issueNumber } : {}),
    action: `Release batch is blocked (${activeEffectiveReason || 'unknown'}). Reconcile via: releases resume --id ${batch.id}`,
  };
}

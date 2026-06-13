export interface ReactivationDecisionInput {
  readyAt: Date;
  now: Date;
  readyMaxDays: number;
  /** Cursor: the newest review activity already processed before READY. */
  lastSeenActivityAt: Date;
  /** Timestamp of the newest review comment currently on the PR (or readyAt if none). */
  newestCommentAt: Date;
}

export type ReactivationAction = 'reactivate' | 'stay_ready' | 'timeout';

export interface ReactivationDecision {
  action: ReactivationAction;
  reason: string;
}

/**
 * Pure policy: given a READY run and the latest review activity, decide
 * whether to reactivate, keep resting, or time out.
 *
 * New activity ALWAYS wins over the deadline.
 */
export function decideReactivation(input: ReactivationDecisionInput): ReactivationDecision {
  const hasNewActivity = input.newestCommentAt.getTime() > input.lastSeenActivityAt.getTime();
  if (hasNewActivity) {
    return { action: 'reactivate', reason: 'new review activity since READY' };
  }
  const deadlineMs = input.readyAt.getTime() + input.readyMaxDays * 24 * 60 * 60 * 1000;
  if (input.now.getTime() > deadlineMs) {
    return { action: 'timeout', reason: `readyMaxDays (${input.readyMaxDays}) exceeded` };
  }
  return { action: 'stay_ready', reason: 'no new activity, within deadline' };
}

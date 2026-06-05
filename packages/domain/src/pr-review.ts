import type { RunId } from './ids.js';

export type CommentState = 'pending' | 'replied' | 'processed' | 'blocked';
export type CommentOutcome = 'fixed' | 'no_fix';

export interface PrReviewComment {
  runId: RunId;
  prNumber: number;
  commentId: number;
  path: string;
  line: number;
  reviewer: string;
  body: string;
  state: CommentState;
  attempts: number;
  outcome?: CommentOutcome;
  replyId?: number;
  commitSha?: string;
  commitVerified: boolean;
  replyVerified: boolean;
  buildVerified: boolean;
  blockedReason?: string;
  lastPoll: number;
  createdAt: Date;
  updatedAt: Date;
}

export class CommentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommentStateError';
  }
}

export interface CreatePrReviewCommentInput {
  runId: RunId;
  prNumber: number;
  commentId: number;
  path: string;
  line: number;
  reviewer: string;
  body: string;
  now: Date;
}

export function createPrReviewComment(input: CreatePrReviewCommentInput): PrReviewComment {
  return {
    runId: input.runId,
    prNumber: input.prNumber,
    commentId: input.commentId,
    path: input.path,
    line: input.line,
    reviewer: input.reviewer,
    body: input.body,
    state: 'pending',
    attempts: 0,
    commitVerified: false,
    replyVerified: false,
    buildVerified: false,
    lastPoll: 0,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function markReplied(
  c: PrReviewComment,
  input: { replyId: number; outcome: CommentOutcome; commitSha?: string; poll: number },
): PrReviewComment {
  return {
    ...c,
    state: 'replied',
    replyId: input.replyId,
    outcome: input.outcome,
    ...(input.commitSha ? { commitSha: input.commitSha } : {}),
    attempts: c.attempts + 1,
    lastPoll: input.poll,
    updatedAt: new Date(),
  };
}

export function markProcessed(
  c: PrReviewComment,
  v: { commitVerified: boolean; replyVerified: boolean; buildVerified: boolean },
): PrReviewComment {
  if (!v.commitVerified || !v.replyVerified || !v.buildVerified) {
    throw new CommentStateError(
      `cannot mark comment ${c.commentId} processed: verification incomplete ` +
        `(commit=${v.commitVerified} reply=${v.replyVerified} build=${v.buildVerified})`,
    );
  }
  return {
    ...c,
    state: 'processed',
    commitVerified: true,
    replyVerified: true,
    buildVerified: true,
    updatedAt: new Date(),
  };
}

export function resetForRetry(c: PrReviewComment, input: { poll: number }): PrReviewComment {
  return { ...c, state: 'pending', lastPoll: input.poll, updatedAt: new Date() };
}

export function blockComment(c: PrReviewComment, reason: string): PrReviewComment {
  return { ...c, state: 'blocked', blockedReason: reason, updatedAt: new Date() };
}

export function isUnresolved(c: PrReviewComment): boolean {
  return c.state === 'pending';
}

export type PollStatus = 'running' | 'completed' | 'failed' | 'rate_limited';

export interface PollAttempt {
  id: string;
  runId: RunId;
  prNumber: number;
  pollNumber: number;
  status: PollStatus;
  commentsFetched: number;
  commentsProcessed: number;
  startedAt: Date;
  completedAt?: Date;
  nextPollAt?: Date;
  terminalState?: 'all_resolved' | 'max_polls_reached' | 'blocked';
}

export interface PrReviewReply {
  id: string;
  runId: RunId;
  prNumber: number;
  commentId: number;
  body: string;
  postedAt: Date;
  verified: boolean;
}

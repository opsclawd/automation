export interface PrReviewCommentDto {
  commentId: number;
  prNumber: number;
  path: string;
  line: number;
  reviewer: string;
  body: string;
  state: 'pending' | 'replied' | 'processed' | 'blocked';
  attempts: number;
  outcome: 'fixed' | 'no_fix' | null;
  replyId: number | null;
  commitSha: string | null;
  commitVerified: boolean;
  replyVerified: boolean;
  buildVerified: boolean;
  blockedReason: string | null;
  lastPoll: number;
  replyBody: string | null;
}

export interface PollAttemptDto {
  id: string;
  pollNumber: number;
  status: 'running' | 'completed' | 'failed' | 'rate_limited';
  commentsFetched: number;
  commentsProcessed: number;
  startedAt: string;
  completedAt: string | null;
  nextPollAt: string | null;
  terminalState: 'all_resolved' | 'max_polls_reached' | 'blocked' | 'timed_out' | null;
}

const STATE_ORDER: Record<PrReviewCommentDto['state'], number> = {
  pending: 0,
  blocked: 1,
  replied: 2,
  processed: 3,
};

export function sortCommentsUnresolvedFirst(comments: PrReviewCommentDto[]): PrReviewCommentDto[] {
  return [...comments].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.commentId - b.commentId,
  );
}

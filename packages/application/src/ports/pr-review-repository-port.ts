import type {
  RunId,
  PrReviewComment,
  PrReviewReply,
  PollAttempt,
  PrReviewCommentAttempt,
} from '@ai-sdlc/domain';

export interface PrReviewRepositoryPort {
  upsertComment(comment: PrReviewComment): void;
  getComment(runId: RunId, commentId: number): PrReviewComment | undefined;
  listComments(runId: RunId): PrReviewComment[];
  insertReply(reply: PrReviewReply): void;
  listReplies(runId: RunId): PrReviewReply[];
  insertPollAttempt(attempt: PollAttempt): void;
  updatePollAttempt(attempt: PollAttempt): void;
  listPollAttempts(runId: RunId): PollAttempt[];
  latestPollAttempt(runId: RunId): PollAttempt | undefined;
  appendCommentAttempt(attempt: PrReviewCommentAttempt): void;
  listCommentAttempts(runId: RunId, commentId: number): PrReviewCommentAttempt[];
}

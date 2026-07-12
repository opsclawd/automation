import type {
  RunId,
  PrReviewComment,
  PrReviewReply,
  PollAttempt,
  PrReviewCommentAttempt,
} from '@ai-sdlc/domain';
import type { PrReviewRepositoryPort } from '../ports/pr-review-repository-port.js';

export class FakePrReviewRepository implements PrReviewRepositoryPort {
  comments = new Map<string, PrReviewComment>();
  replies: PrReviewReply[] = [];
  polls: PollAttempt[] = [];
  commentAttempts: PrReviewCommentAttempt[] = [];

  private key(runId: RunId, commentId: number): string {
    return `${runId}:${commentId}`;
  }

  upsertComment(comment: PrReviewComment): void {
    this.comments.set(this.key(comment.runId, comment.commentId), comment);
  }
  getComment(runId: RunId, commentId: number): PrReviewComment | undefined {
    return this.comments.get(this.key(runId, commentId));
  }
  listComments(runId: RunId): PrReviewComment[] {
    return [...this.comments.values()].filter((c) => c.runId === runId);
  }
  insertReply(reply: PrReviewReply): void {
    if (this.replies.some((r) => r.id === reply.id)) {
      throw new Error(`Unique constraint violation: reply ID ${reply.id} already exists`);
    }
    this.replies.push(reply);
  }
  listReplies(runId: RunId): PrReviewReply[] {
    return this.replies.filter((r) => r.runId === runId);
  }
  insertPollAttempt(attempt: PollAttempt): void {
    if (this.polls.some((p) => p.id === attempt.id)) {
      throw new Error(`Unique constraint violation: poll attempt ID ${attempt.id} already exists`);
    }
    this.polls.push(attempt);
  }
  updatePollAttempt(attempt: PollAttempt): void {
    const i = this.polls.findIndex((p) => p.id === attempt.id);
    if (i >= 0) this.polls[i] = attempt;
  }
  listPollAttempts(runId: RunId): PollAttempt[] {
    return this.polls.filter((p) => p.runId === runId);
  }
  latestPollAttempt(runId: RunId): PollAttempt | undefined {
    const attempts = this.listPollAttempts(runId);
    if (attempts.length === 0) return undefined;
    let best = attempts[0];
    let bestIdx = 0;
    for (let i = 1; i < attempts.length; i++) {
      const a = attempts[i];
      if (!a) continue;
      if (a.pollNumber > best!.pollNumber || (a.pollNumber === best!.pollNumber && i > bestIdx)) {
        best = a;
        bestIdx = i;
      }
    }
    return best;
  }

  appendCommentAttempt(attempt: PrReviewCommentAttempt): void {
    const exists = this.commentAttempts.some(
      (a) =>
        a.runId === attempt.runId &&
        a.commentId === attempt.commentId &&
        a.retryNumber === attempt.retryNumber,
    );
    if (exists) {
      throw new Error(
        `Unique constraint violation: attempt for run ${attempt.runId} comment ${attempt.commentId} retry ${attempt.retryNumber} already exists`,
      );
    }
    this.commentAttempts.push(attempt);
  }

  updateCommentAttempt(attempt: PrReviewCommentAttempt): void {
    const i = this.commentAttempts.findIndex((a) => a.attemptId === attempt.attemptId);
    if (i >= 0) this.commentAttempts[i] = attempt;
  }

  listCommentAttempts(runId: RunId, commentId: number): PrReviewCommentAttempt[] {
    return this.commentAttempts
      .filter((a) => a.runId === runId && a.commentId === commentId)
      .sort((a, b) => {
        if (a.retryNumber !== b.retryNumber) return a.retryNumber - b.retryNumber;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });
  }
}

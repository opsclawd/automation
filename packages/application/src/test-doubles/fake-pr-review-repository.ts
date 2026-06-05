import type { RunId, PrReviewComment, PrReviewReply, PollAttempt } from '@ai-sdlc/domain';
import type { PrReviewRepositoryPort } from '../ports/pr-review-repository-port.js';

export class FakePrReviewRepository implements PrReviewRepositoryPort {
  comments = new Map<string, PrReviewComment>();
  replies: PrReviewReply[] = [];
  polls: PollAttempt[] = [];

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
    this.replies.push(reply);
  }
  listReplies(runId: RunId): PrReviewReply[] {
    return this.replies.filter((r) => r.runId === runId);
  }
  insertPollAttempt(attempt: PollAttempt): void {
    this.polls.push(attempt);
  }
  updatePollAttempt(attempt: PollAttempt): void {
    const i = this.polls.findIndex((p) => p.id === attempt.id);
    if (i >= 0) this.polls[i] = attempt;
    else this.polls.push(attempt);
  }
  listPollAttempts(runId: RunId): PollAttempt[] {
    return this.polls.filter((p) => p.runId === runId);
  }
  latestPollAttempt(runId: RunId): PollAttempt | undefined {
    return this.listPollAttempts(runId).sort((a, b) => b.pollNumber - a.pollNumber)[0];
  }
}

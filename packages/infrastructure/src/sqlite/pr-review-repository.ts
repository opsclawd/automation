import type { Db } from './database.js';
import {
  RunId,
  type PrReviewComment,
  type PrReviewReply,
  type PollAttempt,
  type CommentState,
  type CommentOutcome,
  type PollStatus,
} from '@ai-sdlc/domain';
import type { PrReviewRepositoryPort } from '@ai-sdlc/application/ports';

interface CommentRow {
  run_uuid: string;
  pr_number: number;
  comment_id: number;
  path: string;
  line: number;
  reviewer: string;
  body: string;
  state: string;
  attempts: number;
  outcome: string | null;
  reply_id: number | null;
  commit_sha: string | null;
  commit_verified: number;
  reply_verified: number;
  build_verified: number;
  blocked_reason: string | null;
  last_poll: number;
  created_at: string;
  updated_at: string;
}

function rowToComment(r: CommentRow): PrReviewComment {
  return {
    runId: RunId(r.run_uuid),
    prNumber: r.pr_number,
    commentId: r.comment_id,
    path: r.path,
    line: r.line,
    reviewer: r.reviewer,
    body: r.body,
    state: r.state as CommentState,
    attempts: r.attempts,
    ...(r.outcome !== null ? { outcome: r.outcome as CommentOutcome } : {}),
    ...(r.reply_id !== null ? { replyId: r.reply_id } : {}),
    ...(r.commit_sha !== null ? { commitSha: r.commit_sha } : {}),
    commitVerified: r.commit_verified === 1,
    replyVerified: r.reply_verified === 1,
    buildVerified: r.build_verified === 1,
    ...(r.blocked_reason !== null ? { blockedReason: r.blocked_reason } : {}),
    lastPoll: r.last_poll,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

interface PollRow {
  id: string;
  run_uuid: string;
  pr_number: number;
  poll_number: number;
  status: string;
  comments_fetched: number;
  comments_processed: number;
  started_at: string;
  completed_at: string | null;
  next_poll_at: string | null;
  terminal_state: string | null;
}

function rowToPoll(r: PollRow): PollAttempt {
  const base = {
    id: r.id,
    runId: RunId(r.run_uuid),
    prNumber: r.pr_number,
    pollNumber: r.poll_number,
    status: r.status as PollStatus,
    commentsFetched: r.comments_fetched,
    commentsProcessed: r.comments_processed,
    startedAt: new Date(r.started_at),
  };
  if (r.completed_at !== null) {
    Object.assign(base, { completedAt: new Date(r.completed_at) });
  }
  if (r.next_poll_at !== null) {
    Object.assign(base, { nextPollAt: new Date(r.next_poll_at) });
  }
  if (r.terminal_state !== null) {
    Object.assign(base, { terminalState: r.terminal_state as PollAttempt['terminalState'] });
  }
  return base as PollAttempt;
}

export class PrReviewRepository implements PrReviewRepositoryPort {
  constructor(private readonly db: Db) {}

  upsertComment(c: PrReviewComment): void {
    this.db
      .prepare(
        `INSERT INTO pr_review_comments
          (run_uuid, pr_number, comment_id, path, line, reviewer, body, state, attempts,
           outcome, reply_id, commit_sha, commit_verified, reply_verified, build_verified,
           blocked_reason, last_poll, created_at, updated_at)
         VALUES
          (@runUuid, @prNumber, @commentId, @path, @line, @reviewer, @body, @state, @attempts,
           @outcome, @replyId, @commitSha, @commitVerified, @replyVerified, @buildVerified,
           @blockedReason, @lastPoll, @createdAt, @updatedAt)
         ON CONFLICT(run_uuid, comment_id) DO UPDATE SET
           pr_number=excluded.pr_number, path=excluded.path, line=excluded.line,
           reviewer=excluded.reviewer, body=excluded.body,
           state=excluded.state, attempts=excluded.attempts, outcome=excluded.outcome,
           reply_id=excluded.reply_id, commit_sha=excluded.commit_sha,
           commit_verified=excluded.commit_verified, reply_verified=excluded.reply_verified,
           build_verified=excluded.build_verified, blocked_reason=excluded.blocked_reason,
           last_poll=excluded.last_poll, updated_at=excluded.updated_at`,
      )
      .run({
        runUuid: c.runId,
        prNumber: c.prNumber,
        commentId: c.commentId,
        path: c.path,
        line: c.line,
        reviewer: c.reviewer,
        body: c.body,
        state: c.state,
        attempts: c.attempts,
        outcome: c.outcome ?? null,
        replyId: c.replyId ?? null,
        commitSha: c.commitSha ?? null,
        commitVerified: c.commitVerified ? 1 : 0,
        replyVerified: c.replyVerified ? 1 : 0,
        buildVerified: c.buildVerified ? 1 : 0,
        blockedReason: c.blockedReason ?? null,
        lastPoll: c.lastPoll,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      });
  }

  getComment(runId: RunId, commentId: number): PrReviewComment | undefined {
    const row = this.db
      .prepare('SELECT * FROM pr_review_comments WHERE run_uuid = ? AND comment_id = ?')
      .get(runId, commentId) as CommentRow | undefined;
    return row ? rowToComment(row) : undefined;
  }

  listComments(runId: RunId): PrReviewComment[] {
    const rows = this.db
      .prepare('SELECT * FROM pr_review_comments WHERE run_uuid = ? ORDER BY comment_id')
      .all(runId) as CommentRow[];
    return rows.map(rowToComment);
  }

  insertReply(reply: PrReviewReply): void {
    this.db
      .prepare(
        `INSERT INTO pr_review_replies (id, run_uuid, pr_number, comment_id, body, posted_at, verified)
         VALUES (@id, @runUuid, @prNumber, @commentId, @body, @postedAt, @verified)`,
      )
      .run({
        id: reply.id,
        runUuid: reply.runId,
        prNumber: reply.prNumber,
        commentId: reply.commentId,
        body: reply.body,
        postedAt: reply.postedAt.toISOString(),
        verified: reply.verified ? 1 : 0,
      });
  }

  listReplies(runId: RunId): PrReviewReply[] {
    const rows = this.db
      .prepare('SELECT * FROM pr_review_replies WHERE run_uuid = ? ORDER BY posted_at')
      .all(runId) as Array<{
      id: string;
      run_uuid: string;
      pr_number: number;
      comment_id: number;
      body: string;
      posted_at: string;
      verified: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      runId: RunId(r.run_uuid),
      prNumber: r.pr_number,
      commentId: r.comment_id,
      body: r.body,
      postedAt: new Date(r.posted_at),
      verified: r.verified === 1,
    }));
  }

  insertPollAttempt(a: PollAttempt): void {
    this.db
      .prepare(
        `INSERT INTO poll_attempts
          (id, run_uuid, pr_number, poll_number, status, comments_fetched, comments_processed,
           started_at, completed_at, next_poll_at, terminal_state)
         VALUES
          (@id, @runUuid, @prNumber, @pollNumber, @status, @commentsFetched, @commentsProcessed,
           @startedAt, @completedAt, @nextPollAt, @terminalState)`,
      )
      .run(this.pollParams(a));
  }

  updatePollAttempt(a: PollAttempt): void {
    this.db
      .prepare(
        `UPDATE poll_attempts SET status=@status, comments_fetched=@commentsFetched,
           comments_processed=@commentsProcessed, completed_at=@completedAt,
           next_poll_at=@nextPollAt, terminal_state=@terminalState
         WHERE id=@id`,
      )
      .run(this.pollParams(a));
  }

  private pollParams(a: PollAttempt) {
    return {
      id: a.id,
      runUuid: a.runId,
      prNumber: a.prNumber,
      pollNumber: a.pollNumber,
      status: a.status,
      commentsFetched: a.commentsFetched,
      commentsProcessed: a.commentsProcessed,
      startedAt: a.startedAt.toISOString(),
      completedAt: a.completedAt?.toISOString() ?? null,
      nextPollAt: a.nextPollAt?.toISOString() ?? null,
      terminalState: a.terminalState ?? null,
    };
  }

  listPollAttempts(runId: RunId): PollAttempt[] {
    const rows = this.db
      .prepare('SELECT * FROM poll_attempts WHERE run_uuid = ? ORDER BY poll_number')
      .all(runId) as PollRow[];
    return rows.map(rowToPoll);
  }

  latestPollAttempt(runId: RunId): PollAttempt | undefined {
    const row = this.db
      .prepare('SELECT * FROM poll_attempts WHERE run_uuid = ? ORDER BY poll_number DESC LIMIT 1')
      .get(runId) as PollRow | undefined;
    return row ? rowToPoll(row) : undefined;
  }
}

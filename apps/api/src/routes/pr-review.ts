import type { FastifyInstance } from 'fastify';
import { RunId } from '@ai-sdlc/domain';
import type { Container } from '../compose.js';
import { guardRead } from './_lib.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerPrReviewRoutes(app: FastifyInstance, c: Container): void {
  app.get<{ Params: { uuid: string } }>('/api/runs/:uuid/pr-review', async (req, reply) => {
    const { uuid } = req.params;
    if (!UUID_RE.test(uuid)) {
      reply.code(400);
      return { error: 'invalid run uuid' };
    }
    const run = await guardRead(req, reply, c);
    if (!run) return;
    const runId = RunId(uuid);
    const comments = c.prReviewRepository.listComments(runId).map((cm) => ({
      commentId: cm.commentId,
      prNumber: cm.prNumber,
      path: cm.path,
      line: cm.line,
      reviewer: cm.reviewer,
      body: cm.body,
      state: cm.state,
      attempts: cm.attempts,
      outcome: cm.outcome ?? null,
      replyId: cm.replyId ?? null,
      commitSha: cm.commitSha ?? null,
      commitVerified: cm.commitVerified,
      replyVerified: cm.replyVerified,
      buildVerified: cm.buildVerified,
      blockedReason: cm.blockedReason ?? null,
      lastPoll: cm.lastPoll,
    }));
    const replies = c.prReviewRepository.listReplies(runId);
    const pollAttempts = c.prReviewRepository.listPollAttempts(runId).map((p) => ({
      id: p.id,
      pollNumber: p.pollNumber,
      status: p.status,
      commentsFetched: p.commentsFetched,
      commentsProcessed: p.commentsProcessed,
      startedAt: p.startedAt.toISOString(),
      completedAt: p.completedAt?.toISOString() ?? null,
      nextPollAt: p.nextPollAt?.toISOString() ?? null,
      terminalState: p.terminalState ?? null,
    }));
    const commentsWithReply = comments.map((cm) => ({
      ...cm,
      replyBody: replies.find((r) => r.commentId === cm.commentId)?.body ?? null,
    }));
    return { comments: commentsWithReply, pollAttempts };
  });
}

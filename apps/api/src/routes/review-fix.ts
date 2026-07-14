import type { FastifyInstance } from 'fastify';
import { RunId } from '@ai-sdlc/domain';
import type { Container } from '../compose.js';
import { guardRead } from './_lib.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerReviewFixRoutes(app: FastifyInstance, c: Container): void {
  app.get<{ Params: { uuid: string } }>('/api/runs/:uuid/review-fix', async (req, reply) => {
    const { uuid } = req.params;
    if (!UUID_RE.test(uuid)) {
      reply.code(400);
      return { error: 'invalid run uuid' };
    }
    const result = await guardRead(req, reply, c);
    if (!result) return;
    const loopRepository = result.runtime?.loopRepository ?? c.loopRepository;
    const runId = RunId(uuid);
    const loops = loopRepository.listForRun(runId).map((l) => ({
      id: l.id,
      phaseId: l.phaseId,
      type: l.type,
      status: l.status,
      maxIterations: l.maxIterations,
      startedAt: l.startedAt.toISOString(),
      completedAt: l.completedAt?.toISOString() ?? null,
      iterations: l.iterations.map((it) => ({
        index: it.index,
        outcome: it.outcome ?? null,
        reviewInvocationId: it.reviewInvocationId,
        qualityReviewInvocationId: it.qualityReviewInvocationId ?? null,
        fixInvocationId: it.fixInvocationId ?? null,
        revalidationId: it.revalidationId ?? null,
        reviewArtifactPath: `review-fix/${l.id}/review/${l.phaseId}/iter-${it.index}/code-review.md`,
        fixArtifactPath:
          it.fixInvocationId !== undefined
            ? `review-fix/${l.id}/fix/${l.phaseId}/iter-${it.index}/result.json`
            : null,
        revalidateArtifactPath:
          it.revalidationId !== undefined
            ? `revalidate/${l.id}/${l.phaseId}/iter-${it.index}/validation-result.json`
            : null,
        startedAt: it.startedAt.toISOString(),
        completedAt: it.completedAt?.toISOString() ?? null,
      })),
    }));
    return { loops };
  });
}

import type { FastifyInstance } from 'fastify';
import type { Container } from '../compose.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runsRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get<{ Querystring: { limit?: string; offset?: string } }>('/api/runs', async (req) => {
    const rawLimit = parseInt(req.query.limit ?? '', 10);
    const limit = !Number.isNaN(rawLimit) ? rawLimit : undefined;
    const rawOffset = parseInt(req.query.offset ?? '', 10);
    const offset = !Number.isNaN(rawOffset) ? rawOffset : undefined;
    const pagination =
      limit !== undefined || offset !== undefined
        ? { ...(limit !== undefined ? { limit } : {}), ...(offset !== undefined ? { offset } : {}) }
        : undefined;
    const { runs, total } = c.runRepository.list(pagination);
    return {
      runs: runs.map(c.serializeRun),
      total,
      limit: limit ?? 25,
      offset: offset ?? 0,
    };
  });

  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async (req, reply) => {
    if (!UUID_RE.test(req.params.runId)) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    const run = c.runRepository.findByUuid(req.params.runId);
    if (!run) return reply.code(404).send({ error: 'not_found' });
    const failure = c.failureRepository.findLatestByRun(req.params.runId);
    return { run: c.serializeRun(run), failure: failure ? c.serializeFailure(failure) : null };
  });
}

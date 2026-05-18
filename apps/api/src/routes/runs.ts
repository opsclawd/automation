import type { FastifyInstance } from 'fastify';
import type { Container } from '../compose.js';
import { serializeRun, serializeFailure } from '../serializers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_INT_RE = /^-?\d+$/;

export async function runsRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get<{ Querystring: { limit?: string; offset?: string } }>('/api/runs', async (req, reply) => {
    const MAX_LIMIT = 100;
    if (req.query.limit !== undefined && req.query.limit !== '') {
      if (!DECIMAL_INT_RE.test(req.query.limit)) {
        return reply.code(400).send({ error: 'limit must be a positive integer' });
      }
      const n = Number(req.query.limit);
      if (n < 1) {
        return reply.code(400).send({ error: 'limit must be a positive integer' });
      }
    }
    if (req.query.offset !== undefined && req.query.offset !== '') {
      if (!DECIMAL_INT_RE.test(req.query.offset)) {
        return reply.code(400).send({ error: 'offset must be a non-negative integer' });
      }
      const n = Number(req.query.offset);
      if (n < 0) {
        return reply.code(400).send({ error: 'offset must be a non-negative integer' });
      }
    }
    const limit =
      req.query.limit !== undefined && req.query.limit !== ''
        ? Math.min(Math.max(1, Number(req.query.limit)), MAX_LIMIT)
        : 25;
    const offset =
      req.query.offset !== undefined && req.query.offset !== ''
        ? Math.max(0, Number(req.query.offset))
        : 0;
    const { runs, total } = c.runRepository.list({ limit, offset });
    return {
      runs: runs.map(serializeRun),
      total,
      limit,
      offset,
    };
  });

  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async (req, reply) => {
    if (!UUID_RE.test(req.params.runId)) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    const run = c.runRepository.findByUuid(req.params.runId);
    if (!run) return reply.code(404).send({ error: 'not_found' });
    const failure = c.failureRepository.findLatestByRun(req.params.runId);
    return { run: serializeRun(run), failure: failure ? serializeFailure(failure) : null };
  });
}

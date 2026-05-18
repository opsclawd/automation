import type { FastifyInstance } from 'fastify';
import type { Container } from '../compose.js';
import { serializeRun, serializeFailure } from '../serializers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runsRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get<{ Querystring: { limit?: string; offset?: string } }>('/api/runs', async (req, reply) => {
    const MAX_LIMIT = 100;
    if (req.query.limit !== undefined && req.query.limit !== '') {
      const rawLimit = Number(req.query.limit);
      if (!Number.isFinite(rawLimit) || rawLimit < 1 || !Number.isInteger(rawLimit)) {
        return reply.code(400).send({ error: 'limit must be a positive integer' });
      }
    }
    if (req.query.offset !== undefined && req.query.offset !== '') {
      const rawOffset = Number(req.query.offset);
      if (!Number.isFinite(rawOffset) || rawOffset < 0 || !Number.isInteger(rawOffset)) {
        return reply.code(400).send({ error: 'offset must be a non-negative integer' });
      }
    }
    const rawLimit = parseInt(req.query.limit ?? '', 10);
    const limit = !Number.isNaN(rawLimit) ? Math.min(Math.max(1, rawLimit), MAX_LIMIT) : undefined;
    const rawOffset = parseInt(req.query.offset ?? '', 10);
    const offset = !Number.isNaN(rawOffset) ? Math.max(0, rawOffset) : undefined;
    const pagination = limit !== undefined ? { limit, offset: offset ?? 0 } : undefined;
    const { runs, total } = c.runRepository.list(pagination);
    return {
      runs: runs.map(serializeRun),
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
    return { run: serializeRun(run), failure: failure ? serializeFailure(failure) : null };
  });
}

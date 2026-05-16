import type { FastifyInstance } from 'fastify';
import type { Container } from '../compose.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runsRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get('/api/runs', async () => ({
    runs: c.runRepository.list().map(serializeRun),
  }));

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

function serializeRun(r: ReturnType<Container['runRepository']['list']>[number]) {
  return {
    uuid: r.uuid,
    displayId: r.displayId,
    issueNumber: r.issueNumber,
    status: r.status,
    currentPhase: r.currentPhase !== undefined ? r.currentPhase : null,
    completedPhases: r.completedPhases,
    startedAt: r.startedAt.toISOString(),
    completedAt: r.completedAt !== undefined ? r.completedAt.toISOString() : null,
    exitCode: r.exitCode !== undefined ? r.exitCode : null,
    durationMs: r.durationMs !== undefined ? r.durationMs : null,
    failureReason: r.failureReason !== undefined ? r.failureReason : null,
  };
}

function serializeFailure(
  f: NonNullable<ReturnType<Container['failureRepository']['findLatestByRun']>>,
) {
  return {
    kind: f.kind,
    message: f.message,
    ...(f.phase !== undefined ? { phase: f.phase } : {}),
    ...(f.exitCode !== undefined ? { exitCode: f.exitCode } : {}),
    suggestedAction: f.suggestedAction,
    artifacts: f.artifacts,
  };
}

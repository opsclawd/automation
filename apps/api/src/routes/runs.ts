import type { FastifyInstance } from 'fastify';
import type { Container } from '../compose.js';

export async function runsRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get('/api/runs', async () => ({
    runs: c.runRepository.list().map(serializeRun),
  }));

  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async (req, reply) => {
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
    currentPhase: r.currentPhase ?? null,
    completedPhases: r.completedPhases,
    startedAt: r.startedAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
    exitCode: r.exitCode ?? null,
    durationMs: r.durationMs ?? null,
    failureReason: r.failureReason ?? null,
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

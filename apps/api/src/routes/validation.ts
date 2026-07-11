import type { FastifyInstance } from 'fastify';
import { RunId, validationRunPassed } from '@ai-sdlc/domain';
import type { Container } from '../compose.js';
import { guardRead } from './_lib.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerValidationRoutes(app: FastifyInstance, c: Container): void {
  app.get<{ Params: { uuid: string } }>('/api/runs/:uuid/validation', async (req, reply) => {
    const { uuid } = req.params;
    if (!UUID_RE.test(uuid)) {
      reply.code(400);
      return { error: 'invalid run uuid' };
    }
    const run = await guardRead(req, reply, c);
    if (!run) return;
    const runs = c.validationRunRepository.listByRun(RunId(uuid));
    const ordered = [...runs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    const validationRuns = ordered.map((v) => ({
      id: v.id,
      phaseId: v.phaseId,
      startedAt: v.startedAt.toISOString(),
      completedAt: v.completedAt?.toISOString() ?? null,
      passed: validationRunPassed(v),
      commands: v.commands.map((cmd) => ({
        command: cmd.command,
        kind: cmd.kind ?? null,
        outcome: cmd.outcome,
        exitCode: cmd.exitCode,
        durationMs: cmd.durationMs,
        stdoutPath: cmd.stdoutPath,
        stderrPath: cmd.stderrPath,
        classifier: cmd.classifier ?? null,
      })),
    }));
    return { validationRuns };
  });
}

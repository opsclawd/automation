// Option (b): separate /api/runs/:uuid/invocations rather than embedding
// invocations in the runs response. Keeps the runs payload lean for list
// views — invocations are only fetched when drilling into a specific run.

import type { FastifyInstance } from 'fastify';
import { RunId } from '@ai-sdlc/domain';
import type { Container } from '../compose.js';
import { guardRead } from './_lib.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerInvocationsRoutes(app: FastifyInstance, c: Container): void {
  app.get<{ Params: { uuid: string } }>('/api/runs/:uuid/invocations', async (req, reply) => {
    const { uuid } = req.params;
    if (!UUID_RE.test(uuid)) {
      reply.code(400);
      return { error: 'invalid run uuid' };
    }
    const run = await guardRead(req, reply, c);
    if (!run) return;
    const invocations = c.agentInvocationRepository.listByRun(RunId(uuid)).map((i) => ({
      id: i.id,
      phaseId: i.phaseId,
      stepId: i.stepId ?? null,
      profile: i.profile,
      runtime: i.runtime,
      provider: i.provider,
      model: i.model,
      promptChars: i.promptChars,
      promptTokensApprox: i.promptTokensApprox ?? null,
      startedAt: i.startedAt.toISOString(),
      endedAt: i.endedAt?.toISOString() ?? null,
      durationMs: i.durationMs ?? null,
      exitCode: i.exitCode ?? null,
      outcome: i.outcome ?? null,
      contractViolationsCount: (i.contractViolations ?? []).length,
      fallbackOfInvocationId: i.fallbackOfInvocationId ?? null,
    }));
    return { invocations };
  });
}

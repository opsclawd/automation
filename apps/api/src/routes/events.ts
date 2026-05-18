import type { FastifyInstance } from 'fastify';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type { Container } from '../compose.js';
import { serializeEvent } from '../serializers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function eventsRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get<{ Params: { runId: string }; Querystring: { since?: string } }>(
    '/api/runs/:runId/events',
    async (req, reply) => {
      if (!UUID_RE.test(req.params.runId)) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const run = c.runRepository.findByUuid(req.params.runId);
      if (!run) return reply.code(404).send({ error: 'not_found' });
      let events;
      try {
        events = c.eventRepository.listByRunSince(req.params.runId, req.query.since);
      } catch (e) {
        return reply.code(400).send({ error: 'invalid_since', message: (e as Error).message });
      }
      return { events: events.map((e) => serializeEvent(e, run.displayId)) };
    },
  );

  app.get<{ Params: { runId: string }; Querystring: { since?: string } }>(
    '/api/runs/:runId/events/stream',
    async (req, reply) => {
      if (!UUID_RE.test(req.params.runId)) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const run = c.runRepository.findByUuid(req.params.runId);
      if (!run) return reply.code(404).send({ error: 'not_found' });

      // Hijack the reply to take over raw socket control for SSE streaming.
      // Fastify should not manage the response lifecycle after this point.
      reply.hijack();

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      reply.raw.flushHeaders();

      const sseSend = (id: number | string, payload: unknown): void => {
        reply.raw.write(`id: ${id}\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      let lastTimestamp: string | undefined;
      let backfillEvents;
      try {
        backfillEvents = c.eventRepository.listByRunSince(req.params.runId, req.query.since);
      } catch {
        reply.raw.end();
        return;
      }

      for (const e of backfillEvents) {
        sseSend(e.id, serializeEvent(e, run.displayId));
        lastTimestamp = e.timestamp.toISOString();
      }

      // MVP limitation: if two events share the same millisecond timestamp,
      // reconnecting with ?since=<that timestamp> may miss one event.
      // A future story can add (timestamp, id) total-order cursors.
      const unsub = c.eventBus.subscribe(req.params.runId, (ev: OrchestratorEvent) => {
        if (lastTimestamp !== undefined && ev.timestamp <= lastTimestamp) return;
        sseSend(ev.timestamp, {
          runId: run.displayId,
          phase: ev.phase ?? null,
          level: ev.level,
          type: ev.type,
          message: ev.message,
          timestamp: ev.timestamp,
          metadata: ev.metadata,
        });
      });

      const heartbeat = setInterval(() => {
        reply.raw.write(': hb\n\n');
      }, 15_000);

      req.raw.on('close', () => {
        clearInterval(heartbeat);
        unsub();
      });
    },
  );
}

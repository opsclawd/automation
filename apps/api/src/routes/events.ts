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

      // Validate `since` parameter before committing to the SSE stream
      // so we can return proper 400 errors instead of sending 200 then ending.
      if (req.query.since !== undefined && Number.isNaN(Date.parse(req.query.since))) {
        return reply
          .code(400)
          .send({ error: 'invalid_since', message: 'since must be a valid ISO 8601 timestamp' });
      }

      // Hijack the reply to take over raw socket control for SSE streaming.
      // Fastify should not manage the response lifecycle after this point.
      reply.hijack();

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      reply.raw.flushHeaders();

      let streamClosed = false;
      const sseSend = (id: number | string, payload: unknown): void => {
        if (streamClosed) return;
        try {
          reply.raw.write(`id: ${id}\ndata: ${JSON.stringify(payload)}\n\n`);
        } catch {
          cleanup();
        }
      };

      // Subscribe BEFORE backfill to eliminate the race window where events
      // published between backfill completion and bus subscription are lost.
      // Live events received during backfill are queued and deduplicated after.
      let lastTimestamp: string | null = null;
      let backfillComplete = false;
      const liveQueue: OrchestratorEvent[] = [];
      const unsub = c.eventBus.subscribe(req.params.runId, (ev: OrchestratorEvent) => {
        if (streamClosed) return;
        if (backfillComplete && lastTimestamp !== null && ev.timestamp <= lastTimestamp) return;
        if (!backfillComplete) {
          // Still in backfill phase — queue for later.
          liveQueue.push(ev);
        } else {
          sseSend(ev.timestamp, {
            runId: run.displayId,
            phase: ev.phase ?? null,
            level: ev.level,
            type: ev.type,
            message: ev.message,
            timestamp: ev.timestamp,
            metadata: ev.metadata,
          });
        }
      });

      let backfillEvents;
      try {
        backfillEvents = c.eventRepository.listByRunSince(req.params.runId, req.query.since);
      } catch {
        sseSend('error', { error: 'invalid_since' });
        unsub();
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

      // Mark backfill complete so the bus listener switches to direct-send.
      backfillComplete = true;

      // Drain the live queue — events buffered during backfill are deduplicated
      // against lastTimestamp (skip any with timestamp <= lastTimestamp).
      // If lastTimestamp is null (no backfill events), all live events are sent.
      for (const ev of liveQueue) {
        if (lastTimestamp !== null && ev.timestamp <= lastTimestamp) continue;
        sseSend(ev.timestamp, {
          runId: run.displayId,
          phase: ev.phase ?? null,
          level: ev.level,
          type: ev.type,
          message: ev.message,
          timestamp: ev.timestamp,
          metadata: ev.metadata,
        });
      }

      const heartbeat = setInterval(() => {
        if (streamClosed) return;
        try {
          reply.raw.write(': hb\n\n');
        } catch {
          cleanup();
        }
      }, 15_000);

      function cleanup() {
        if (streamClosed) return;
        streamClosed = true;
        clearInterval(heartbeat);
        unsub();
      }

      req.raw.on('close', () => {
        cleanup();
      });

      reply.raw.on('error', () => {
        cleanup();
      });
    },
  );
}

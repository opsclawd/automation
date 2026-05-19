'use client';

import { useEffect, useState } from 'react';
import { listRunEvents } from '@/lib/api-client';
import type { ApiEvent } from '@/lib/timeline';

interface UseRunEventsResult {
  events: ApiEvent[];
  error: Error | null;
}

// Live SSE events from the server omit the `id` field (only backfilled
// events include it). Use a compound key so deduplication works regardless.
function eventKey(e: ApiEvent): string {
  if (e.id !== undefined && e.id !== null) return `id:${e.id}`;
  return `${e.type}:${e.phase ?? '_'}:${e.timestamp}`;
}

export function useRunEvents(runUuid: string): UseRunEventsResult {
  const [events, setEvents] = useState<ApiEvent[]>([]);
  const [error, setError] = useState<Error | null>(null);

  const MAX_EVENTS = 2000;

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;

    (async () => {
      try {
        const backfill = await listRunEvents(runUuid);
        if (cancelled) return;
        setEvents(backfill);

        const lastTimestamp = backfill.at(-1)?.timestamp;
        const streamUrl = lastTimestamp
          ? `/api/runs/${runUuid}/events/stream?since=${encodeURIComponent(lastTimestamp)}`
          : `/api/runs/${runUuid}/events/stream`;

        es = new EventSource(streamUrl);
        es.onmessage = (msg) => {
          try {
            setError(null);
            const parsed = JSON.parse(msg.data) as ApiEvent;
            const dedupeKey = eventKey(parsed);
            setEvents((prev) => {
              if (prev.some((p) => eventKey(p) === dedupeKey)) return prev;
              const next = [...prev, parsed];
              if (next.length > MAX_EVENTS) next.splice(0, next.length - MAX_EVENTS);
              return next;
            });
          } catch {
            // ignore malformed SSE frames
          }
        };
        es.onerror = () => {
          setError(new Error('event stream interrupted'));
          // EventSource auto-reconnects; nothing else to do
        };
        es.onopen = () => {
          setError(null);
        };
      } catch (e) {
        if (!cancelled) setError(e as Error);
      }
    })();

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [runUuid]);

  return { events, error };
}

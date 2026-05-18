'use client';

import { useEffect, useState } from 'react';
import { listRunEvents } from '@/lib/api-client';
import type { ApiEvent } from '@/lib/timeline';

interface UseRunEventsResult {
  events: ApiEvent[];
  error: Error | null;
}

export function useRunEvents(runUuid: string): UseRunEventsResult {
  const [events, setEvents] = useState<ApiEvent[]>([]);
  const [error, setError] = useState<Error | null>(null);

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
            setEvents((prev) => {
              if (prev.some((p) => p.id === parsed.id)) return prev;
              return [...prev, parsed];
            });
          } catch {
            // ignore malformed SSE frames
          }
        };
        es.onerror = () => {
          setError(new Error('event stream interrupted'));
          // EventSource auto-reconnects; nothing else to do
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

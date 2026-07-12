'use client';

import { useEffect, useState } from 'react';
import { listRunEvents } from '@/lib/api-client';
import type { ApiEvent } from '@/lib/timeline';

interface UseRunEventsResult {
  events: ApiEvent[];
  error: Error | null;
  isLoading: boolean;
}

// Use a compound key that is stable across live SSE payloads (which omit the
// `id` field) and persisted/backfilled events (which include it). Using
// `id:N` for one form and the compound key for the other would let the same
// real-world event survive as a duplicate after reconnection.
function eventKey(e: ApiEvent): string {
  const path = typeof e.metadata?.path === 'string' ? e.metadata.path : '';
  const msg = e.message ? e.message : '';
  return `${e.type}:${e.phase ?? '_'}:${e.timestamp}:${path}:${msg}`;
}

export function useRunEvents(repositoryId: string, runUuid: string): UseRunEventsResult {
  const [events, setEvents] = useState<ApiEvent[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const MAX_EVENTS = 2000;

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const MAX_BACKOFF_MS = 30_000;

    function scheduleRetry(attempt: number) {
      const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
      retryTimer = setTimeout(() => {
        if (!cancelled) startBackfill(attempt + 1);
      }, delay);
    }

    function startBackfill(attempt: number) {
      listRunEvents(repositoryId, runUuid)
        .then((backfill) => {
          if (cancelled) return;
          setEvents(backfill);
          setIsLoading(false);
          setError(null);

          const lastTimestamp = backfill.at(-1)?.timestamp;
          const search = new URLSearchParams({ repositoryId });
          if (lastTimestamp) {
            search.set('since', lastTimestamp);
          }
          const streamUrl = `/api/runs/${runUuid}/events/stream?${search.toString()}`;

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
          };
          es.onopen = () => {
            setError(null);
          };
        })
        .catch((e) => {
          if (cancelled) return;
          setIsLoading(false);
          setError(e as Error);
          scheduleRetry(attempt);
        });
    }

    startBackfill(0);

    return () => {
      cancelled = true;
      es?.close();
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [repositoryId, runUuid]);

  return { events, error, isLoading };
}

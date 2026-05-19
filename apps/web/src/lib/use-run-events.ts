'use client';

import { useEffect, useState } from 'react';
import { listRunEvents } from '@/lib/api-client';
import type { ApiEvent } from '@/lib/timeline';

interface UseRunEventsResult {
  events: ApiEvent[];
  error: Error | null;
  isLoading: boolean;
}

// Live SSE events from the server omit the `id` field (only backfilled
// events include it). Use a compound key so deduplication works regardless.
// Include payload fields to avoid collapsing distinct events that share
// type/phase/timestamp (e.g. multiple artifact.created in the same ms).
function eventKey(e: ApiEvent): string {
  if (e.id !== undefined && e.id !== null) return `id:${e.id}`;
  const path = typeof e.metadata?.path === 'string' ? e.metadata.path : '';
  const msg = e.message ? e.message : '';
  return `${e.type}:${e.phase ?? '_'}:${e.timestamp}:${path}:${msg}`;
}

export function useRunEvents(runUuid: string): UseRunEventsResult {
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
      listRunEvents(runUuid)
        .then((backfill) => {
          if (cancelled) return;
          setEvents(backfill);
          setIsLoading(false);
          setError(null);

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
  }, [runUuid]);

  return { events, error, isLoading };
}

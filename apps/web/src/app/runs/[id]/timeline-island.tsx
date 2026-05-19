'use client';

import { useMemo } from 'react';
import { useRunEvents } from '@/lib/use-run-events';
import { derivePhaseTimeline } from '@/lib/timeline';
import { PhaseTimeline } from './phase-timeline';

interface TimelineIslandProps {
  runUuid: string;
}

export function TimelineIsland({ runUuid }: TimelineIslandProps) {
  const { events, error } = useRunEvents(runUuid);
  const timeline = useMemo(() => derivePhaseTimeline(events), [events]);
  return (
    <div>
      {error ? (
        <div className="mb-2 text-xs text-yellow-400" data-testid="timeline-warning">
          {error.message} — reconnecting…
        </div>
      ) : null}
      {events.length === 0 && !error ? (
        <div className="text-sm text-slate-500" data-testid="timeline-loading">
          Loading timeline…
        </div>
      ) : (
        <PhaseTimeline timeline={timeline} />
      )}
    </div>
  );
}

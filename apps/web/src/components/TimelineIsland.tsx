'use client';

import { useMemo } from 'react';
import { useRunEvents } from '@/lib/use-run-events';
import { derivePhaseTimeline } from '@/lib/timeline';
import { PhaseTimeline } from './PhaseTimeline';

interface TimelineIslandProps {
  repositoryId: string;
  runUuid: string;
}

export function TimelineIsland({ repositoryId, runUuid }: TimelineIslandProps) {
  const { events, error, isLoading } = useRunEvents(repositoryId, runUuid);
  const timeline = useMemo(() => derivePhaseTimeline(events), [events]);
  return (
    <div>
      {error ? (
        <div className="mb-2 text-xs text-yellow-400" data-testid="timeline-warning">
          {error.message}
        </div>
      ) : null}
      {isLoading ? (
        <div className="text-sm text-slate-500" data-testid="timeline-loading">
          Loading timeline…
        </div>
      ) : (
        <PhaseTimeline timeline={timeline} />
      )}
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { listReviewFix } from '@/lib/api-client';
import {
  loopBadge,
  iterationChip,
  PILL_CLASS,
  type LoopDto,
  type PillColor,
} from '@/lib/review-fix';
import { ArtifactViewer } from './ArtifactViewer';

function Pill({ color, children }: { color: PillColor; children: React.ReactNode }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${PILL_CLASS[color]}`}>
      {children}
    </span>
  );
}

export function ReviewFixPanel({ runUuid }: { runUuid: string }) {
  const [loops, setLoops] = useState<LoopDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let intervalId: ReturnType<typeof setInterval> | undefined;

    async function fetchData() {
      try {
        const d = await listReviewFix(runUuid);
        if (!live) return;
        setLoops(d);
        setError(null);
        if (d.some((l) => l.status === 'running')) {
          intervalId ??= setInterval(fetchData, 10000);
        } else if (intervalId !== undefined) {
          clearInterval(intervalId);
          intervalId = undefined;
        }
      } catch (e) {
        if (!live) return;
        setError(String(e));
      }
    }

    fetchData();
    return () => {
      live = false;
      if (intervalId !== undefined) clearInterval(intervalId);
    };
  }, [runUuid]);

  if (error) {
    return <div className="text-sm text-red-600">Failed to load review/fix: {error}</div>;
  }
  if (loops === null) {
    return <div className="text-sm text-slate-500">Loading review/fix…</div>;
  }
  if (loops.length === 0) {
    return <div className="text-sm text-slate-500">No review/fix activity for this run.</div>;
  }

  return (
    <div className="space-y-4">
      {loops.map((loop) => {
        const badge = loopBadge(loop.status);
        return (
          <div key={loop.id} className="rounded border p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-medium text-sm">{loop.phaseId}</span>
              <Pill color={badge.color}>{badge.label}</Pill>
              <span className="text-xs text-slate-500">
                {loop.iterations.length} / {loop.maxIterations} iterations
              </span>
            </div>
            {loop.iterations.length > 0 ? (
              <ul className="space-y-1">
                {loop.iterations.map((it) => {
                  const chip = iterationChip(it.outcome);
                  return (
                    <li key={it.index} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="w-24 text-slate-500 text-xs">Iteration {it.index}</span>
                      <Pill color={chip.color}>{chip.label}</Pill>
                      <ArtifactViewer runId={runUuid} fileName={it.reviewArtifactPath} />
                      {it.fixArtifactPath && (
                        <ArtifactViewer runId={runUuid} fileName={it.fixArtifactPath} />
                      )}
                      {it.revalidateArtifactPath && (
                        <ArtifactViewer runId={runUuid} fileName={it.revalidateArtifactPath} />
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="text-xs text-slate-400">No iterations yet.</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

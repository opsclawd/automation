'use client';

import { useEffect, useState } from 'react';
import { listValidation } from '@/lib/api-client';
import { sortCommandsFailingFirst, type ValidationRunDto } from '@/lib/validation';
import { formatDuration } from '@/lib/format';
import { ArtifactViewer } from './ArtifactViewer';

const PILL: Record<string, string> = {
  passed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  timed_out: 'bg-amber-100 text-amber-800',
};

export function ValidationPanel({
  repositoryId,
  runUuid,
}: {
  repositoryId: string;
  runUuid: string;
}) {
  const [runs, setRuns] = useState<ValidationRunDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let live = true;
    listValidation(repositoryId, runUuid)
      .then((r) => {
        if (live) setRuns(r);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [repositoryId, runUuid]);

  if (error) return <div className="text-sm text-red-600">Failed to load validation: {error}</div>;
  if (runs === null) return <div className="text-sm text-slate-500">Loading validation…</div>;
  if (runs.length === 0)
    return <div className="text-sm text-slate-500">No validation data for this run.</div>;

  const run = runs[Math.min(selected, runs.length - 1)]!;
  const commands = sortCommandsFailingFirst(run.commands);

  return (
    <div className="space-y-4">
      {runs.length > 1 && (
        <label className="text-sm text-slate-600">
          Validation run:{' '}
          <select
            className="rounded border px-1 py-0.5"
            value={selected}
            onChange={(e) => setSelected(Number(e.target.value))}
          >
            {runs.map((r, i) => (
              <option key={r.id} value={i}>
                {new Date(r.startedAt).toLocaleString()} {r.passed ? '✓' : '✗'}
              </option>
            ))}
          </select>
        </label>
      )}

      <ul className="space-y-2">
        {commands.map((c, index) => (
          <li key={`${c.command}-${index}`} className="rounded border p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${PILL[c.outcome] ?? ''}`}>
                {c.outcome}
              </span>
              {c.kind && (
                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  {c.kind}
                </span>
              )}
              <code className="font-mono">{c.command}</code>
              <span className="ml-auto text-slate-500">{formatDuration(c.durationMs)}</span>
            </div>
            {c.outcome !== 'passed' && c.classifier && (
              <pre className="mt-1 whitespace-pre-wrap text-xs text-red-700">{c.classifier}</pre>
            )}
            <div className="mt-2 flex flex-col gap-1">
              <ArtifactViewer
                repositoryId={repositoryId}
                runId={runUuid}
                fileName={c.stdoutPath}
                fileSize={0}
              />
              <ArtifactViewer
                repositoryId={repositoryId}
                runId={runUuid}
                fileName={c.stderrPath}
                fileSize={0}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

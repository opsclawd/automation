'use client';

import type { PhaseTimelineEntry } from '@/lib/timeline';

interface PhaseTimelineProps {
  timeline: PhaseTimelineEntry[];
}

const PHASE_LABELS: Record<string, string> = {
  read_issue: 'Read Issue',
  'plan-design': 'Plan Design',
  'plan-write': 'Plan Write',
  implement: 'Implement',
  validate: 'Validate',
  'fix-validate': 'Fix Validate',
  'whole-pr-review': 'Whole-PR Review',
  'fix-review': 'Fix Review',
  compound: 'Compound',
  'create-pr': 'Create PR',
};

export function PhaseTimeline({ timeline }: PhaseTimelineProps) {
  return (
    <ol className="space-y-2" data-testid="phase-timeline">
      {timeline.map((entry) => (
        <li
          key={entry.name}
          data-testid={`phase-${entry.name}`}
          data-status={entry.status}
          className="flex items-start gap-3 rounded border border-slate-700 bg-slate-900 p-3"
        >
          <StatusDot status={entry.status} />
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm">{PHASE_LABELS[entry.name] ?? entry.name}</span>
              <span className="text-xs text-slate-400" data-testid={`phase-${entry.name}-duration`}>
                {formatTimelineDuration(entry.durationMs)}
              </span>
            </div>
            {entry.failure ? (
              <div
                className={`mt-1 text-xs ${entry.status === 'blocked' ? 'text-orange-300' : 'text-red-300'}`}
                data-testid={`phase-${entry.name}-failure`}
              >
                {entry.failure.message}
              </div>
            ) : null}
            {entry.artifacts.length > 0 ? (
              <ul className="mt-1 space-y-0.5 text-xs text-slate-300">
                {entry.artifacts.map((a, i) => (
                  <li key={`${a.kind}:${a.path}:${i}`}>
                    <span className="text-slate-500">{a.kind}</span> {a.path}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function StatusDot({ status }: { status: PhaseTimelineEntry['status'] }) {
  const colour = {
    pending: 'bg-slate-600',
    running: 'bg-blue-500 animate-pulse',
    passed: 'bg-green-500',
    failed: 'bg-red-500',
    skipped: 'bg-yellow-600',
    blocked: 'bg-orange-500',
  }[status];
  return <span aria-label={status} className={`mt-1.5 h-2 w-2 rounded-full ${colour}`} />;
}

// Intentionally diverges from @/lib/format.Duration — timeline needs sub-second
// precision (e.g. 0.3s, 450ms) while the shared version rounds to whole seconds.
function formatTimelineDuration(ms: number | null): string {
  if (ms === null) return '\u2014';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  return `${s}s`;
}

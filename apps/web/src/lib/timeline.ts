export const CANONICAL_PHASES = [
  'read_issue',
  'plan-design',
  'plan-write',
  'implement',
  'validate',
  'whole-pr-review',
  'fix-review',
  'compound',
  'create-pr',
] as const;

export type PhaseName = (typeof CANONICAL_PHASES)[number];

export interface ApiEvent {
  id: number;
  runId: string;
  phase: string | null;
  level: 'info' | 'warn' | 'error';
  type: string;
  message: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface PhaseTimelineEntry {
  name: PhaseName;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'blocked';
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  artifacts: Array<{ path: string; kind: string }>;
  failure?: { message: string; metadata: Record<string, unknown> };
}

const CANONICAL_SET = new Set<string>(CANONICAL_PHASES);

export function derivePhaseTimeline(events: ApiEvent[]): PhaseTimelineEntry[] {
  const byPhase = new Map<PhaseName, PhaseTimelineEntry>();
  for (const name of CANONICAL_PHASES) {
    byPhase.set(name, {
      name,
      status: 'pending',
      startedAt: null,
      completedAt: null,
      durationMs: null,
      artifacts: [],
    });
  }

  for (const e of events) {
    if (e.phase === null || !CANONICAL_SET.has(e.phase)) continue;
    const entry = byPhase.get(e.phase as PhaseName)!;
    const meta: Record<string, unknown> =
      typeof e.metadata === 'object' && e.metadata !== null && !Array.isArray(e.metadata)
        ? e.metadata
        : {};

    switch (e.type) {
      case 'phase.started':
        if (entry.status === 'pending') {
          entry.startedAt = e.timestamp;
          entry.status = 'running';
        }
        break;
      case 'phase.completed':
        if (entry.status === 'running' || entry.status === 'pending') {
          entry.completedAt = e.timestamp;
          entry.status = 'passed';
          entry.durationMs = computeDuration(entry.startedAt, e.timestamp);
        }
        break;
      case 'phase.failed': {
        const isBlocked = typeof meta.reason === 'string' && /blocked|waiting/i.test(meta.reason);
        entry.completedAt = e.timestamp;
        entry.status = isBlocked ? 'blocked' : 'failed';
        entry.durationMs = computeDuration(entry.startedAt, e.timestamp);
        entry.failure = { message: e.message, metadata: meta };
        break;
      }
      case 'phase.skipped':
        entry.status = 'skipped';
        break;
      case 'artifact.created': {
        const path = typeof meta.path === 'string' ? meta.path : null;
        const kind = typeof meta.kind === 'string' ? meta.kind : 'unknown';
        if (path !== null) entry.artifacts.push({ path, kind });
        break;
      }
      default:
        break;
    }
  }

  return CANONICAL_PHASES.map((n) => byPhase.get(n)!);
}

function computeDuration(startISO: string | null, endISO: string): number | null {
  if (startISO === null) return null;
  const start = Date.parse(startISO);
  const end = Date.parse(endISO);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

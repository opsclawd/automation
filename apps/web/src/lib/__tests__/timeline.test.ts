import { describe, it, expect } from 'vitest';
import { derivePhaseTimeline, CANONICAL_PHASES } from '../timeline';
import type { ApiEvent } from '../timeline';

const ev = (over: Partial<ApiEvent>): ApiEvent => ({
  id: 1,
  runId: 'R-001',
  phase: null,
  level: 'info',
  type: 'x',
  message: '',
  timestamp: '2026-05-16T12:00:00.000Z',
  metadata: {},
  ...over,
});

describe('derivePhaseTimeline', () => {
  it('returns all 9 canonical phases as pending when given no events (AC1)', () => {
    const timeline = derivePhaseTimeline([]);
    expect(timeline).toHaveLength(CANONICAL_PHASES.length);
    for (const entry of timeline) {
      expect(entry.status).toBe('pending');
      expect(entry.durationMs).toBeNull();
      expect(entry.startedAt).toBeNull();
      expect(entry.completedAt).toBeNull();
      expect(entry.artifacts).toEqual([]);
      expect(entry.failure).toBeUndefined();
    }
  });

  it('returns phases in canonical order (AC7)', () => {
    const timeline = derivePhaseTimeline([]);
    expect(timeline.map((p) => p.name)).toEqual([...CANONICAL_PHASES]);
  });

  it('marks a phase running after phase.started and sets startedAt (AC2)', () => {
    const timeline = derivePhaseTimeline([
      ev({
        id: 1,
        phase: 'plan-write',
        type: 'phase.started',
        timestamp: '2026-05-16T12:00:00.000Z',
      }),
    ]);
    const pw = timeline.find((p) => p.name === 'plan-write')!;
    expect(pw.status).toBe('running');
    expect(pw.startedAt).toBe('2026-05-16T12:00:00.000Z');
    expect(pw.durationMs).toBeNull();
  });

  it('marks a phase passed after phase.completed and computes durationMs (AC3)', () => {
    const timeline = derivePhaseTimeline([
      ev({
        id: 1,
        phase: 'plan-write',
        type: 'phase.started',
        timestamp: '2026-05-16T12:00:00.000Z',
      }),
      ev({
        id: 2,
        phase: 'plan-write',
        type: 'phase.completed',
        timestamp: '2026-05-16T12:00:03.000Z',
      }),
    ]);
    const pw = timeline.find((p) => p.name === 'plan-write')!;
    expect(pw.status).toBe('passed');
    expect(pw.completedAt).toBe('2026-05-16T12:00:03.000Z');
    expect(pw.durationMs).toBe(3000);
  });

  it('marks a phase failed with failure payload and computes durationMs (AC4)', () => {
    const timeline = derivePhaseTimeline([
      ev({
        id: 1,
        phase: 'validate',
        type: 'phase.started',
        timestamp: '2026-05-16T12:00:00.000Z',
      }),
      ev({
        id: 2,
        phase: 'validate',
        type: 'phase.failed',
        level: 'error',
        message: 'build failed',
        timestamp: '2026-05-16T12:00:05.000Z',
        metadata: { command: 'pnpm build', exitCode: 2 },
      }),
    ]);
    const v = timeline.find((p) => p.name === 'validate')!;
    expect(v.status).toBe('failed');
    expect(v.completedAt).toBe('2026-05-16T12:00:05.000Z');
    expect(v.durationMs).toBe(5000);
    expect(v.failure?.message).toBe('build failed');
    expect(v.failure?.metadata.exitCode).toBe(2);
  });

  it('marks phase.skipped phases as skipped, does not set timestamps (AC5)', () => {
    const timeline = derivePhaseTimeline([
      ev({
        id: 1,
        phase: 'read_issue',
        type: 'phase.skipped',
        level: 'warn',
        timestamp: '2026-05-16T12:00:00.000Z',
      }),
    ]);
    const ri = timeline.find((p) => p.name === 'read_issue')!;
    expect(ri.status).toBe('skipped');
    expect(ri.startedAt).toBeNull();
    expect(ri.completedAt).toBeNull();
  });

  it('attaches artifact.created events to the correct phase (AC6)', () => {
    const timeline = derivePhaseTimeline([
      ev({
        id: 1,
        phase: 'plan-design',
        type: 'artifact.created',
        timestamp: '2026-05-16T12:00:01.000Z',
        metadata: { path: '/tmp/design.md', kind: 'design' },
      }),
    ]);
    const pd = timeline.find((p) => p.name === 'plan-design')!;
    expect(pd.artifacts).toEqual([{ path: '/tmp/design.md', kind: 'design' }]);
  });

  it('ignores artifact.created when metadata.path is not a string', () => {
    const timeline = derivePhaseTimeline([
      ev({
        id: 1,
        phase: 'plan-design',
        type: 'artifact.created',
        timestamp: '2026-05-16T12:00:01.000Z',
        metadata: { kind: 'design' },
      }),
    ]);
    const pd = timeline.find((p) => p.name === 'plan-design')!;
    expect(pd.artifacts).toEqual([]);
  });

  it('ignores events with phase=null (run-level events) (AC7)', () => {
    const timeline = derivePhaseTimeline([ev({ id: 1, phase: null, type: 'run.started' })]);
    expect(timeline.every((p) => p.status === 'pending')).toBe(true);
  });

  it('ignores events for unknown phase names (AC7)', () => {
    const timeline = derivePhaseTimeline([
      ev({ id: 1, phase: 'invented-phase', type: 'phase.started' }),
    ]);
    expect(timeline.every((p) => p.status === 'pending')).toBe(true);
  });

  it('keeps phases in canonical order regardless of event arrival order', () => {
    const timeline = derivePhaseTimeline([
      ev({
        id: 1,
        phase: 'whole-pr-review',
        type: 'phase.started',
        timestamp: '2026-05-16T12:00:01.000Z',
      }),
      ev({
        id: 2,
        phase: 'plan-design',
        type: 'phase.started',
        timestamp: '2026-05-16T12:00:00.000Z',
      }),
    ]);
    expect(timeline.map((p) => p.name)).toEqual([...CANONICAL_PHASES]);
    expect(timeline.find((p) => p.name === 'whole-pr-review')!.status).toBe('running');
    expect(timeline.find((p) => p.name === 'plan-design')!.status).toBe('running');
  });

  it('computes sub-second duration correctly', () => {
    const timeline = derivePhaseTimeline([
      ev({
        id: 1,
        phase: 'implement',
        type: 'phase.started',
        timestamp: '2026-05-16T12:00:00.000Z',
      }),
      ev({
        id: 2,
        phase: 'implement',
        type: 'phase.completed',
        timestamp: '2026-05-16T12:00:00.450Z',
      }),
    ]);
    const impl = timeline.find((p) => p.name === 'implement')!;
    expect(impl.durationMs).toBe(450);
  });

  it('returns null durationMs when startedAt is missing for completed/failed', () => {
    const timeline = derivePhaseTimeline([
      ev({
        id: 1,
        phase: 'implement',
        type: 'phase.completed',
        timestamp: '2026-05-16T12:00:01.000Z',
      }),
    ]);
    const impl = timeline.find((p) => p.name === 'implement')!;
    expect(impl.status).toBe('passed');
    expect(impl.durationMs).toBeNull();
  });

  it('does not revert a completed phase back to running on late phase.started', () => {
    const timeline = derivePhaseTimeline([
      ev({
        id: 1,
        phase: 'validate',
        type: 'phase.started',
        timestamp: '2026-05-16T12:00:00.000Z',
      }),
      ev({
        id: 2,
        phase: 'validate',
        type: 'phase.failed',
        level: 'error',
        message: 'oops',
        timestamp: '2026-05-16T12:00:05.000Z',
      }),
      ev({
        id: 3,
        phase: 'validate',
        type: 'phase.started',
        timestamp: '2026-05-16T12:00:06.000Z',
      }),
    ]);
    const v = timeline.find((p) => p.name === 'validate')!;
    expect(v.status).toBe('failed');
    expect(v.completedAt).toBe('2026-05-16T12:00:05.000Z');
  });

  it('does not overwrite failed status with late phase.completed (AC4 idempotency)', () => {
    const timeline = derivePhaseTimeline([
      ev({
        id: 1,
        phase: 'validate',
        type: 'phase.started',
        timestamp: '2026-05-16T12:00:00.000Z',
      }),
      ev({
        id: 2,
        phase: 'validate',
        type: 'phase.failed',
        level: 'error',
        message: 'oops',
        timestamp: '2026-05-16T12:00:05.000Z',
      }),
      ev({
        id: 3,
        phase: 'validate',
        type: 'phase.completed',
        timestamp: '2026-05-16T12:00:06.000Z',
      }),
    ]);
    const v = timeline.find((p) => p.name === 'validate')!;
    expect(v.status).toBe('failed');
    expect(v.completedAt).toBe('2026-05-16T12:00:05.000Z');
    expect(v.failure?.message).toBe('oops');
  });

  it('marks phase as blocked when phase.failed metadata.reason contains "blocked"', () => {
    const timeline = derivePhaseTimeline([
      ev({
        id: 1,
        phase: 'implement',
        type: 'phase.started',
        timestamp: '2026-05-16T12:00:00.000Z',
      }),
      ev({
        id: 2,
        phase: 'implement',
        type: 'phase.failed',
        level: 'error',
        message: "Phase 'implement' is blocked (agent emitted BLOCKED)",
        timestamp: '2026-05-16T12:00:10.000Z',
        metadata: { reason: "Phase 'implement' is blocked (agent emitted BLOCKED)" },
      }),
    ]);
    const impl = timeline.find((p) => p.name === 'implement')!;
    expect(impl.status).toBe('blocked');
    expect(impl.completedAt).toBe('2026-05-16T12:00:10.000Z');
    expect(impl.durationMs).toBe(10_000);
    expect(impl.failure?.message).toBe("Phase 'implement' is blocked (agent emitted BLOCKED)");
  });

  it('marks phase as blocked when phase.failed metadata.reason contains "waiting"', () => {
    const timeline = derivePhaseTimeline([
      ev({
        id: 1,
        phase: 'implement',
        type: 'phase.started',
        timestamp: '2026-05-16T12:00:00.000Z',
      }),
      ev({
        id: 2,
        phase: 'implement',
        type: 'phase.failed',
        level: 'error',
        message: 'waiting for human input',
        timestamp: '2026-05-16T12:00:08.000Z',
        metadata: { reason: 'waiting for human input' },
      }),
    ]);
    const impl = timeline.find((p) => p.name === 'implement')!;
    expect(impl.status).toBe('blocked');
    expect(impl.failure?.message).toBe('waiting for human input');
  });

  it('marks phase as failed when phase.failed metadata.reason is absent', () => {
    const timeline = derivePhaseTimeline([
      ev({
        id: 1,
        phase: 'validate',
        type: 'phase.started',
        timestamp: '2026-05-16T12:00:00.000Z',
      }),
      ev({
        id: 2,
        phase: 'validate',
        type: 'phase.failed',
        level: 'error',
        message: 'build failed',
        timestamp: '2026-05-16T12:00:05.000Z',
        metadata: { command: 'pnpm build', exitCode: 1 },
      }),
    ]);
    const v = timeline.find((p) => p.name === 'validate')!;
    expect(v.status).toBe('failed');
  });

  it('marks phase as failed when phase.failed metadata.reason is not a string', () => {
    const timeline = derivePhaseTimeline([
      ev({
        id: 1,
        phase: 'validate',
        type: 'phase.started',
        timestamp: '2026-05-16T12:00:00.000Z',
      }),
      ev({
        id: 2,
        phase: 'validate',
        type: 'phase.failed',
        level: 'error',
        message: 'build failed',
        timestamp: '2026-05-16T12:00:05.000Z',
        metadata: { reason: 42 },
      }),
    ]);
    const v = timeline.find((p) => p.name === 'validate')!;
    expect(v.status).toBe('failed');
  });
});

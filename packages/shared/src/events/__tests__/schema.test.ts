import { describe, it, expect } from 'vitest';
import { eventSchema, type OrchestratorEvent } from '../schema.js';

describe('eventSchema', () => {
  const minimal = {
    runId: 'issue-1-20260516-120000',
    level: 'info' as const,
    type: 'run.started',
    message: 'hi',
    timestamp: '2026-05-16T12:00:00.000Z',
  };

  it('accepts a minimal run-level event (no phase)', () => {
    const parsed = eventSchema.parse(minimal);
    expect(parsed.runId).toBe('issue-1-20260516-120000');
    expect(parsed.phase).toBeUndefined();
    expect(parsed.metadata).toEqual({});
  });

  it('accepts a phase-level event', () => {
    const parsed = eventSchema.parse({ ...minimal, phase: 'plan-write', type: 'phase.started' });
    expect(parsed.phase).toBe('plan-write');
  });

  it('rejects unknown levels', () => {
    expect(() => eventSchema.parse({ ...minimal, level: 'fatal' })).toThrow();
  });

  it('rejects empty type and empty runId', () => {
    expect(() => eventSchema.parse({ ...minimal, type: '' })).toThrow();
    expect(() => eventSchema.parse({ ...minimal, runId: '' })).toThrow();
  });

  it('rejects non-ISO timestamps', () => {
    expect(() => eventSchema.parse({ ...minimal, timestamp: 'last tuesday' })).toThrow();
  });

  it('rejects locale-style and numeric-only timestamps', () => {
    expect(() => eventSchema.parse({ ...minimal, timestamp: '1' })).toThrow();
    expect(() => eventSchema.parse({ ...minimal, timestamp: '05/16/2026' })).toThrow();
  });

  it('accepts timestamps with timezone offsets', () => {
    const parsed = eventSchema.parse({ ...minimal, timestamp: '2026-05-16T12:00:00+05:30' });
    expect(parsed.timestamp).toBe('2026-05-16T12:00:00+05:30');
  });

  it('defaults metadata to {}', () => {
    const { metadata: _metadata, ...withoutMeta } = minimal;
    const parsed = eventSchema.parse(withoutMeta);
    expect(parsed.metadata).toEqual({});
  });

  it('preserves arbitrary metadata values (numbers, booleans, strings)', () => {
    const parsed = eventSchema.parse({
      ...minimal,
      metadata: { exitCode: 2, ok: true, command: 'pnpm build' },
    });
    expect(parsed.metadata).toEqual({ exitCode: 2, ok: true, command: 'pnpm build' });
  });

  it('type-narrows OrchestratorEvent to required fields', () => {
    const ev: OrchestratorEvent = minimal;
    expect(ev.message).toBe('hi');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createImplementStepHistoryFilePort } from '../implement-step-history-file-port.js';
import type {
  EventBusPort,
  StepLoopContext,
  ImplementStepHistoryEntry,
} from '@ai-sdlc/application';
import { RunId, PhaseName } from '@ai-sdlc/domain';

function makeEventBus(): { bus: EventBusPort; events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    bus: {
      publish: (_runId: string, e: unknown) => events.push(e),
      subscribe: () => () => {},
    },
  };
}

function makeCtx(cwd: string): StepLoopContext {
  return {
    loopId: 'l1',
    runId: RunId('run-1'),
    phaseId: PhaseName('implement'),
    repoId: 'o/r',
    cwd,
    stepIndex: 2,
    stepTitle: 'step',
    iterationIndex: 1,
  };
}

describe('createImplementStepHistoryFilePort', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'impl-history-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('returns an empty list when no history file exists', async () => {
    const { bus } = makeEventBus();
    const port = createImplementStepHistoryFilePort(bus);
    const entries = await port.read(makeCtx(cwd));
    expect(entries).toEqual([]);
  });

  it('writes entries through append and reads them back', async () => {
    const { bus } = makeEventBus();
    const port = createImplementStepHistoryFilePort(bus);
    const ctx = makeCtx(cwd);
    const entry: ImplementStepHistoryEntry = {
      iteration: 1,
      specReview: { verdict: 'pass' },
      qualityReview: { verdict: 'pass' },
      outcome: 'resolved',
    };
    await port.append(ctx, entry);
    expect(existsSync(join(cwd, 'implement-step-history-2.json'))).toBe(true);
    const back = await port.read(ctx);
    expect(back).toHaveLength(1);
    expect(back[0]?.outcome).toBe('resolved');
  });

  it('appends multiple entries (preserves chronology)', async () => {
    const { bus } = makeEventBus();
    const port = createImplementStepHistoryFilePort(bus);
    const ctx = makeCtx(cwd);
    await port.append(ctx, {
      iteration: 1,
      specReview: { verdict: 'fail' },
      qualityReview: { verdict: 'pass' },
      outcome: 'fixed',
    });
    await port.append(ctx, {
      iteration: 2,
      specReview: { verdict: 'pass' },
      qualityReview: { verdict: 'pass' },
      outcome: 'resolved',
    });
    const back = await port.read(ctx);
    expect(back.map((e) => e.iteration)).toEqual([1, 2]);
    const fileContents = readFileSync(join(cwd, 'implement-step-history-2.json'), 'utf-8');
    expect(fileContents).toContain('"resolved"');
  });

  it('read() catches invalid JSON, emits a warn event, and recovers gracefully', async () => {
    const { bus, events } = makeEventBus();
    const port = createImplementStepHistoryFilePort(bus);
    const ctx = makeCtx(cwd);
    writeFileSync(join(cwd, 'implement-step-history-2.json'), 'invalid json');
    const entries = await port.read(ctx);
    expect(entries).toEqual([]);
    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe('implement_step_history.read_failed');
  });

  it('append() catches invalid JSON, emits a warn event, and recovers gracefully', async () => {
    const { bus, events } = makeEventBus();
    const port = createImplementStepHistoryFilePort(bus);
    const ctx = makeCtx(cwd);
    writeFileSync(join(cwd, 'implement-step-history-2.json'), 'invalid json');
    const entry: ImplementStepHistoryEntry = {
      iteration: 1,
      specReview: { verdict: 'pass' },
      qualityReview: { verdict: 'pass' },
      outcome: 'resolved',
    };
    await port.append(ctx, entry);
    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe('implement_step_history.read_failed');

    // File should be overwritten with valid JSON containing just the new entry
    const back = await port.read(ctx);
    expect(back).toHaveLength(1);
    expect(back[0]?.outcome).toBe('resolved');
  });
});

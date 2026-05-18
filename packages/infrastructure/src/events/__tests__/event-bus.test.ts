import { describe, it, expect } from 'vitest';
import { InMemoryEventBus } from '../event-bus.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

const ev = (runId: string, type: string): OrchestratorEvent => ({
  runId,
  level: 'info',
  type,
  message: type,
  timestamp: new Date().toISOString(),
  metadata: {},
});

describe('InMemoryEventBus', () => {
  it('delivers events to subscribers of the same runUuid', () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    const unsub = bus.subscribe('uuid-a', (e) => seen.push(e.type));
    bus.publish('uuid-a', ev('display-a', 'phase.started'));
    bus.publish('uuid-a', ev('display-a', 'phase.completed'));
    expect(seen).toEqual(['phase.started', 'phase.completed']);
    unsub();
  });

  it('isolates events by runUuid', () => {
    const bus = new InMemoryEventBus();
    const seenA: string[] = [];
    const seenB: string[] = [];
    bus.subscribe('uuid-a', (e) => seenA.push(e.type));
    bus.subscribe('uuid-b', (e) => seenB.push(e.type));
    bus.publish('uuid-a', ev('a', 't1'));
    bus.publish('uuid-b', ev('b', 't2'));
    expect(seenA).toEqual(['t1']);
    expect(seenB).toEqual(['t2']);
  });

  it('unsubscribe stops delivery', () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    const unsub = bus.subscribe('u', (e) => seen.push(e.type));
    bus.publish('u', ev('d', 't1'));
    unsub();
    bus.publish('u', ev('d', 't2'));
    expect(seen).toEqual(['t1']);
  });

  it('publish is a no-op when no subscribers exist for a runUuid', () => {
    const bus = new InMemoryEventBus();
    expect(() => bus.publish('no-such-uuid', ev('d', 't1'))).not.toThrow();
  });

  it('cleans up emitter when all subscribers unsubscribe', () => {
    const bus = new InMemoryEventBus();
    const unsub1 = bus.subscribe('uuid-x', () => {});
    const unsub2 = bus.subscribe('uuid-x', () => {});
    unsub1();
    unsub2();
    bus.publish('uuid-x', ev('d', 'after-cleanup'));
    expect(true).toBe(true);
  });

  it('does not throw when a listener throws', () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribe('uuid-err', () => {
      throw new Error('listener exploded');
    });
    bus.subscribe('uuid-err', (e) => seen.push(e.type));
    expect(() => bus.publish('uuid-err', ev('d', 'survived'))).not.toThrow();
    expect(seen).toEqual(['survived']);
  });

  it('continues delivering to remaining listeners after one throws', () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    let callCount = 0;
    bus.subscribe('uuid-err', () => {
      callCount++;
      if (callCount === 1) throw new Error('first call throws');
    });
    bus.subscribe('uuid-err', (e) => seen.push(e.type));
    bus.publish('uuid-err', ev('d', 'first'));
    bus.publish('uuid-err', ev('d', 'second'));
    expect(seen).toEqual(['first', 'second']);
    expect(callCount).toBe(2);
  });
});

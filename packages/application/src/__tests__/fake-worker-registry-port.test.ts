import { describe, expect, it } from 'vitest';
import { createWorker, WorkerId } from '@ai-sdlc/domain';
import { FakeWorkerRegistryPort } from '../test-doubles/index.js';

const now = new Date('2026-01-01T00:00:00Z');

function worker(id: string) {
  return createWorker({ id: WorkerId(id), hostname: 'h', processId: 1, now });
}

describe('FakeWorkerRegistryPort', () => {
  it('register and list', () => {
    const port = new FakeWorkerRegistryPort();
    port.register(worker('w1'));
    expect(port.list()).toHaveLength(1);
  });

  it('heartbeat updates heartbeatAt', () => {
    const port = new FakeWorkerRegistryPort();
    port.register(worker('w1'));
    const later = new Date(now.getTime() + 60_000);
    port.heartbeat(WorkerId('w1'), later);
    expect(port.findById(WorkerId('w1'))?.heartbeatAt).toEqual(later);
  });

  it('findById returns worker', () => {
    const port = new FakeWorkerRegistryPort();
    port.register(worker('w1'));
    expect(port.findById(WorkerId('w1'))?.hostname).toBe('h');
  });

  it('findById returns undefined for unknown', () => {
    const port = new FakeWorkerRegistryPort();
    expect(port.findById(WorkerId('unknown'))).toBeUndefined();
  });

  it('markStopping sets status', () => {
    const port = new FakeWorkerRegistryPort();
    port.register(worker('w1'));
    port.markStopping(WorkerId('w1'));
    expect(port.findById(WorkerId('w1'))?.status).toBe('stopping');
  });

  it('markUnhealthy sets status', () => {
    const port = new FakeWorkerRegistryPort();
    port.register(worker('w1'));
    port.markUnhealthy(WorkerId('w1'));
    expect(port.findById(WorkerId('w1'))?.status).toBe('unhealthy');
  });

  it('markBusy sets status', () => {
    const port = new FakeWorkerRegistryPort();
    port.register(worker('w1'));
    port.markBusy(WorkerId('w1'));
    expect(port.findById(WorkerId('w1'))?.status).toBe('busy');
  });

  it('markIdle sets status', () => {
    const port = new FakeWorkerRegistryPort();
    port.register(worker('w1'));
    port.markIdle(WorkerId('w1'));
    expect(port.findById(WorkerId('w1'))?.status).toBe('idle');
  });

  it('update on unknown worker throws', () => {
    const port = new FakeWorkerRegistryPort();
    expect(() => port.heartbeat(WorkerId('unknown'), now)).toThrow('unknown worker');
  });

  it('markStopping on unknown worker throws', () => {
    const port = new FakeWorkerRegistryPort();
    expect(() => port.markStopping(WorkerId('unknown'))).toThrow('unknown worker');
  });
});

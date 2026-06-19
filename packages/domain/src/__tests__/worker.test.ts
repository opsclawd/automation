import { describe, expect, it } from 'vitest';
import { WorkerId } from '../ids.js';
import {
  createWorker,
  heartbeatWorker,
  markWorkerBusy,
  markWorkerIdle,
  markWorkerStopping,
  markWorkerUnhealthy,
} from '../worker.js';

const w0 = {
  id: WorkerId('w1'),
  hostname: 'h',
  processId: 100,
  now: new Date('2026-01-01T00:00:00Z'),
};

describe('Worker', () => {
  it('createWorker starts idle', () => {
    expect(createWorker(w0).status).toBe('idle');
  });
  it('heartbeatWorker updates heartbeatAt', () => {
    const w = createWorker(w0);
    const ts = new Date('2026-01-01T00:01:00Z');
    expect(heartbeatWorker(w, ts).heartbeatAt).toEqual(ts);
  });
  it('markWorkerStopping / Unhealthy set status', () => {
    const w = createWorker(w0);
    expect(markWorkerStopping(w).status).toBe('stopping');
    expect(markWorkerUnhealthy(w).status).toBe('unhealthy');
  });
  it('markWorkerBusy sets status to busy', () => {
    const w = createWorker(w0);
    expect(markWorkerBusy(w).status).toBe('busy');
  });
  it('markWorkerIdle sets busy/idle to idle', () => {
    const w = createWorker(w0);
    expect(markWorkerIdle(w).status).toBe('idle');
    expect(markWorkerIdle(markWorkerBusy(w)).status).toBe('idle');
  });
  it('markWorkerIdle preserves stopping/unhealthy', () => {
    const w = markWorkerStopping(createWorker(w0));
    expect(markWorkerIdle(w).status).toBe('stopping');
    const u = markWorkerUnhealthy(createWorker(w0));
    expect(markWorkerIdle(u).status).toBe('unhealthy');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { SchedulerTelemetryRecord } from '@ai-sdlc/application/ports';
import type { RepositoryId } from '@ai-sdlc/domain';

describe('DefaultSchedulerTelemetry', () => {
  it('writes JSON records to an injected logger and stores latest gauges/counters in memory', async () => {
    const { DefaultSchedulerTelemetry } = await import('../scheduler-telemetry.js');

    const debugLogs: unknown[] = [];
    const infoLogs: unknown[] = [];

    const logger = {
      debug: vi.fn((msg: string, meta?: unknown) => {
        debugLogs.push({ msg, meta });
      }),
      info: vi.fn((msg: string, meta?: unknown) => {
        infoLogs.push({ msg, meta });
      }),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const telemetry = new DefaultSchedulerTelemetry({ logger });

    const record1: SchedulerTelemetryRecord = {
      type: 'scheduler.pool.active',
      count: 2,
    };
    telemetry.record(record1);

    const record2: SchedulerTelemetryRecord = {
      type: 'scheduler.repository.queue_depth',
      repository_id: 'owner/repo' as RepositoryId,
      repository_name: 'repo',
      depth: 5,
    };
    telemetry.record(record2);

    expect(telemetry.getPoolActive()).toBe(2);
    expect(telemetry.getRepositoryQueueDepth('owner/repo' as RepositoryId)).toBe(5);

    expect(
      infoLogs.some(
        (l: unknown) =>
          (l as { msg: string }).msg === 'scheduler.telemetry' &&
          (l as { meta: { record: SchedulerTelemetryRecord } }).meta.record.type ===
            'scheduler.pool.active',
      ),
    ).toBe(true);
    expect(
      infoLogs.some(
        (l: unknown) =>
          (l as { msg: string }).msg === 'scheduler.telemetry' &&
          (l as { meta: { record: SchedulerTelemetryRecord } }).meta.record.type ===
            'scheduler.repository.queue_depth',
      ),
    ).toBe(true);
  });

  it('suppresses repeated identical unavailability warnings until repository visibility changes', async () => {
    const { DefaultSchedulerTelemetry } = await import('../scheduler-telemetry.js');

    const warnLogs: Array<{ msg: string; meta?: unknown }> = [];

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn((msg: string, meta?: unknown) => {
        warnLogs.push({ msg, meta });
      }),
      error: vi.fn(),
    };

    const telemetry = new DefaultSchedulerTelemetry({ logger });

    const repoId = 'owner/repo' as RepositoryId;

    const skip1: SchedulerTelemetryRecord = {
      type: 'scheduler.repository.skipped',
      repository_id: repoId,
      repository_name: 'repo',
      reason: 'unavailable',
      detail: 'runtime unavailable',
    };
    telemetry.record(skip1);
    telemetry.record(skip1);
    telemetry.record(skip1);

    expect(warnLogs.filter((l) => l.msg === 'scheduler.repository.skipped')).toHaveLength(1);

    const skip2: SchedulerTelemetryRecord = {
      type: 'scheduler.repository.skipped',
      repository_id: repoId,
      repository_name: 'repo',
      reason: 'unavailable',
      detail: 'different error', // changed detail
    };
    telemetry.record(skip2);

    expect(warnLogs.filter((l) => l.msg === 'scheduler.repository.skipped')).toHaveLength(2);

    const skip3: SchedulerTelemetryRecord = {
      type: 'scheduler.repository.skipped',
      repository_id: repoId,
      repository_name: 'repo',
      reason: 'unhealthy', // changed reason
      detail: 'different error',
    };
    telemetry.record(skip3);

    expect(warnLogs.filter((l) => l.msg === 'scheduler.repository.skipped')).toHaveLength(3);

    const skip4: SchedulerTelemetryRecord = {
      type: 'scheduler.repository.skipped',
      repository_id: repoId,
      repository_name: 'repo',
      reason: 'unavailable',
      detail: 'different error',
    };
    telemetry.record(skip4);
    telemetry.record(skip4);

    expect(warnLogs.filter((l) => l.msg === 'scheduler.repository.skipped')).toHaveLength(3);

    telemetry.record({
      type: 'scheduler.repository.skipped',
      repository_id: repoId,
      repository_name: 'repo',
      reason: 'no_work',
    });
    telemetry.record({
      type: 'scheduler.repository.skipped',
      repository_id: repoId,
      repository_name: 'repo',
      reason: 'unavailable',
      detail: 'different error',
    });

    expect(warnLogs.filter((l) => l.msg === 'scheduler.repository.skipped')).toHaveLength(5);
  });

  it('stores and returns gauge values', async () => {
    const { DefaultSchedulerTelemetry } = await import('../scheduler-telemetry.js');

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const telemetry = new DefaultSchedulerTelemetry({ logger });

    telemetry.record({
      type: 'scheduler.pool.active',
      count: 5,
    });

    expect(telemetry.getPoolActive()).toBe(5);

    telemetry.record({
      type: 'scheduler.pool.active',
      count: 3,
    });

    expect(telemetry.getPoolActive()).toBe(3);
  });

  it('stores and returns counter values', async () => {
    const { DefaultSchedulerTelemetry } = await import('../scheduler-telemetry.js');

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const telemetry = new DefaultSchedulerTelemetry({ logger });

    telemetry.record({
      type: 'scheduler.dispatch.total',
      count: 10,
    });

    expect(telemetry.getDispatchTotal()).toBe(10);

    telemetry.record({
      type: 'scheduler.dispatch.total',
      count: 5,
    });

    expect(telemetry.getDispatchTotal()).toBe(5);
  });

  it('stores per-repository metrics', async () => {
    const { DefaultSchedulerTelemetry } = await import('../scheduler-telemetry.js');

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const telemetry = new DefaultSchedulerTelemetry({ logger });

    const repo1 = 'owner/repo1' as RepositoryId;
    const repo2 = 'owner/repo2' as RepositoryId;

    telemetry.record({
      type: 'scheduler.repository.active',
      repository_id: repo1,
      repository_name: 'repo1',
      count: 2,
    });

    telemetry.record({
      type: 'scheduler.repository.queue_depth',
      repository_id: repo2,
      repository_name: 'repo2',
      depth: 3,
    });

    expect(telemetry.getRepositoryActive(repo1)).toBe(2);
    expect(telemetry.getRepositoryQueueDepth(repo2)).toBe(3);
    expect(telemetry.getRepositoryActive(repo2)).toBe(0);
    expect(telemetry.getRepositoryQueueDepth(repo1)).toBe(0);
  });
});

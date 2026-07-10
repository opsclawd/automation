import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const createdDirs: string[] = [];

function makeRepo(opts: { withPostPrReview?: boolean; readyMaxDays?: number } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-compose-sweep-'));
  createdDirs.push(dir);
  const config: Record<string, unknown> = {
    validation: { commands: ['pnpm build'], timeout: 300 },
    phases: {
      skip: [],
      reviewFix: { maxIterations: 10 },
      implement: { maxIterations: 5 },
    },
    timeouts: { readyMaxDays: opts.readyMaxDays ?? 7, invocationMaxMinutes: 30 },
  };
  if (opts.withPostPrReview) {
    (config.phases as Record<string, unknown>).postPrReview = {
      maxPolls: 10,
      pollIntervalSeconds: 60,
      firstReviewGraceWindowSeconds: 1800,
    };
  }
  writeFileSync(join(dir, '.ai-orchestrator.json'), JSON.stringify(config));
  return dir;
}

afterEach(() => {
  for (const d of createdDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  createdDirs.length = 0;
  vi.restoreAllMocks();
});

const { sweepsConstructed, lastReadyMaxDays } = vi.hoisted(() => ({
  sweepsConstructed: { count: 0 },
  lastReadyMaxDays: { value: undefined as number | undefined },
}));

vi.mock('@ai-sdlc/application', async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  const Real = mod.SweepWaitingRuns as new (...args: unknown[]) => unknown;
  return {
    ...mod,
    SweepWaitingRuns: class extends Real {
      constructor(...args: unknown[]) {
        super(...args);
        sweepsConstructed.count++;
        if (args[0] && typeof args[0] === 'object' && 'readyMaxDays' in args[0]) {
          lastReadyMaxDays.value = (args[0] as { readyMaxDays: number }).readyMaxDays;
        }
      }
    },
  };
});

describe('composeRoot — SweepWaitingRuns wiring', () => {
  beforeEach(() => {
    sweepsConstructed.count = 0;
    lastReadyMaxDays.value = undefined;
  });

  it('invokes SweepWaitingRuns when runStartupSweeps !== false', async () => {
    const { composeRoot } = await import('../compose.js');
    const repoRoot = makeRepo({ withPostPrReview: true });
    composeRoot({ repoRoot, scriptPath: '/dev/null' });
    expect(sweepsConstructed.count).toBe(1);
  });

  it('does NOT invoke SweepWaitingRuns when runStartupSweeps === false', async () => {
    const { composeRoot } = await import('../compose.js');
    const repoRoot = makeRepo({ withPostPrReview: true });
    composeRoot({ repoRoot, scriptPath: '/dev/null', runStartupSweeps: false });
    expect(sweepsConstructed.count).toBe(0);
  });

  it('passes configured readyMaxDays from config to SweepWaitingRuns', async () => {
    const { composeRoot } = await import('../compose.js');
    const repoRoot = makeRepo({ withPostPrReview: true, readyMaxDays: 30 });
    composeRoot({ repoRoot, scriptPath: '/dev/null' });
    expect(sweepsConstructed.count).toBe(1);
    expect(lastReadyMaxDays.value).toBe(30);
  });
});

describe('composeRoot — serve sweep wiring', () => {
  it('defaults serveSweepIntervalSeconds to 0 when config omits serve', async () => {
    const { composeRoot } = await import('../compose.js');
    const repoRoot = makeRepo({ withPostPrReview: true });
    const c = composeRoot({ repoRoot, scriptPath: '/dev/null', runStartupSweeps: false });
    expect(c.serveSweepIntervalSeconds).toBe(0);
  });

  it('exposes buildWaitingRunsSweeper that constructs a working WaitingRunsSweeper', async () => {
    const { composeRoot } = await import('../compose.js');
    const repoRoot = makeRepo({ withPostPrReview: true });
    const c = composeRoot({ repoRoot, scriptPath: '/dev/null', runStartupSweeps: false });
    expect(c.buildWaitingRunsSweeper).toBeTypeOf('function');
    const sweeper = c.buildWaitingRunsSweeper();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await sweeper.execute('serve-test' as any);
    expect(result.scanned).toBe(0);
    expect(result.enqueued).toBe(0);
  });
});

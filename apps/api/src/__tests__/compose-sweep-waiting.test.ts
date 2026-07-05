import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const createdDirs: string[] = [];

function makeRepo(opts: { withPostPrReview?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-compose-sweep-'));
  createdDirs.push(dir);
  const config: Record<string, unknown> = {
    validation: { commands: ['pnpm build'], timeout: 300 },
    phases: {
      skip: [],
      reviewFix: { maxIterations: 10 },
      implement: { maxIterations: 5 },
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
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

const { sweepsConstructed } = vi.hoisted(() => ({ sweepsConstructed: { count: 0 } }));

vi.mock('@ai-sdlc/application', async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  const Real = mod.SweepWaitingRuns as new (...args: unknown[]) => unknown;
  return {
    ...mod,
    SweepWaitingRuns: class extends Real {
      constructor(...args: unknown[]) {
        super(...args);
        sweepsConstructed.count++;
      }
    },
  };
});

describe('composeRoot — SweepWaitingRuns wiring', () => {
  beforeEach(() => {
    sweepsConstructed.count = 0;
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
});

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeRoot, type ComposeOptions } from '../compose.js';
import { WebhookRunNotificationAdapter, NoopRunNotificationAdapter } from '@ai-sdlc/infrastructure';
import { RepositoryId } from '@ai-sdlc/domain';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function trackDir<T>(fn: () => T): T {
  const result = fn();
  tempDirs.push(result);
  return result;
}

function fakeScript(): string {
  const dir = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-script-')));
  const scriptPath = path.join(dir, 'run.sh');
  writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  return scriptPath;
}

function makeConfig(overrides?: Record<string, unknown>): object {
  return {
    validation: { commands: ['echo ok'], timeout: 60 },
    phases: {
      skip: [],
      reviewFix: { maxIterations: 3 },
      implement: { maxIterations: 3 },
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
    agent: {
      defaultProfile: 'test',
      profiles: {
        test: { runtime: 'opencode', provider: 'test', model: 'test', timeoutMinutes: 1 },
      },
      phaseProfiles: {
        'whole-pr-review': { profile: 'test' },
        'fix-review': { profile: 'test' },
        'fix-validate': { profile: 'test' },
      },
    },
    ...overrides,
  };
}

const FAKE_METADATA_RESOLVER: ComposeOptions['metadataResolver'] = {
  resolve: (p) => ({
    rootPath: p,
    nameWithOwner: 'owner/repo',
    defaultBranch: 'main',
    remoteUrl: 'https://github.com/owner/repo.git',
  }),
};

describe('RunNotification wiring in composeRoot', () => {
  it('wires NoopRunNotificationAdapter by default when notifications config is absent', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-notify-')));
    const scriptPath = fakeScript();
    writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(makeConfig()));

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
    });

    expect(container.runNotification).toBeDefined();
    expect(container.runNotification).toBeInstanceOf(NoopRunNotificationAdapter);
    expect(container.runExecutor).toBeDefined();
  });

  it('wires WebhookRunNotificationAdapter when notifications.runWebhookUrl is configured', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-notify-')));
    const scriptPath = fakeScript();
    writeFileSync(
      path.join(root, '.ai-orchestrator.json'),
      JSON.stringify(
        makeConfig({
          notifications: {
            runWebhookUrl: 'https://ntfy.sh/alerts-topic',
          },
        }),
      ),
    );

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
    });

    expect(container.runNotification).toBeDefined();
    expect(container.runNotification).toBeInstanceOf(WebhookRunNotificationAdapter);
    expect(container.runExecutor).toBeDefined();

    const loopDeps = container.workerLoopDeps?.(RepositoryId('owner/repo'));
    expect(loopDeps?.runNotification).toBe(container.runNotification);
    expect(
      (container.startIssueRun as unknown as { deps: { runNotification?: unknown } }).deps
        .runNotification,
    ).toBe(container.runNotification);
  });

  it('exposes drainStartupSweeps which awaits startup sweeps', async () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-notify-')));
    const scriptPath = fakeScript();
    writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(makeConfig()));

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
    });

    expect(container.drainStartupSweeps).toBeTypeOf('function');
    expect(container.startupSweepPromise).toBeDefined();
    await expect(container.drainStartupSweeps!()).resolves.toBeUndefined();
  });

  it('tracks dynamically registered startup sweep promises in drainStartupSweeps', async () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-notify-')));
    const scriptPath = fakeScript();
    writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(makeConfig()));

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
      runStartupSweeps: false,
    });

    expect(container.startupSweepPromise).toBeUndefined();

    let sweepCompleted = false;
    const customSweepPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        sweepCompleted = true;
        resolve();
      }, 50);
    });

    container.trackStartupSweep?.(customSweepPromise);
    expect(container.startupSweepPromise).toBeDefined();

    await container.drainStartupSweeps!();
    expect(sweepCompleted).toBe(true);
  });

  it('drainStartupSweeps respects timeout when dynamic sweep stalls', async () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-notify-')));
    const scriptPath = fakeScript();
    writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(makeConfig()));

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
      runStartupSweeps: false,
    });

    // Stalled promise that never resolves
    const stalledPromise = new Promise<void>(() => {});
    container.trackStartupSweep?.(stalledPromise);

    const start = Date.now();
    await container.drainStartupSweeps!(100);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
  });
});

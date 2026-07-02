import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { composeRoot } from '../compose.js';
import { RepositoryId } from '@ai-sdlc/domain';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function trackDir<T>(fn: () => T): T {
  const result = fn();
  tempDirs.push(result as string);
  return result;
}

function makeRoot(): string {
  return trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-durable-')));
}

function fakeScript(root: string): string {
  const scriptPath = join(root, 'noop.sh');
  writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 0\n', 'utf-8');
  return scriptPath;
}

describe('composeRoot durable artifact wiring', () => {
  it('writes phase artifacts to the durable run store and mirrors them to the worktree', async () => {
    const root = makeRoot();
    writeFileSync(
      join(root, '.ai-orchestrator.json'),
      JSON.stringify({
        validation: { commands: ['echo ok'], timeout: 60 },
        phases: {
          skip: [],
          reviewFix: { maxIterations: 3, blockOnSeverity: 'medium' },
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
          },
        },
      }),
      'utf-8',
    );

    const container = composeRoot({
      repoRoot: root,
      scriptPath: fakeScript(root),
      repoFullName: 'owner/repo',
    });

    const run = {
      uuid: '7b31b4e1-3dc2-4e3c-9c16-9f3ad7280c0f',
      displayId: 'issue-42-20260622-120000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 42,
      type: 'issue_to_pr' as const,
      status: 'running' as const,
      completedPhases: [],
      skippedPhases: [],
      startedAt: new Date('2026-06-22T12:00:00.000Z'),
    };

    container.runRepository.insertIfNoActive(run);
    const ctx = container.buildRunContext?.(run);
    expect(ctx).toBeDefined();
    expect(ctx?.cwd).toBe(join(root, '.ai-worktrees', 'issue-42'));

    const durableRoot = join(root, '.ai-runs', run.displayId, 'phase-artifacts');
    const mirroredRoot = join(root, '.ai-worktrees', 'issue-42');

    await ctx!.artifacts.write({
      runId: run.uuid,
      phaseId: 'implement',
      relativePath: 'implementation-log.md',
      contents: '# implementation log\n',
    });

    const durableFile = join(durableRoot, 'implementation-log.md');
    const mirroredFile = join(mirroredRoot, 'implementation-log.md');
    expect(existsSync(durableFile)).toBe(true);
    expect(existsSync(mirroredFile)).toBe(true);
    expect(readFileSync(durableFile, 'utf-8')).toBe('# implementation log\n');
    expect(readFileSync(mirroredFile, 'utf-8')).toBe('# implementation log\n');

    rmSync(mirroredFile);

    await expect(ctx!.artifacts.read(run.uuid, 'implementation-log.md')).resolves.toBe(
      '# implementation log\n',
    );

    await ctx!.artifacts.write({
      runId: run.uuid,
      phaseId: 'implement',
      relativePath: 'validate/nested-note.md',
      contents: 'nested durable artifact\n',
    });

    rmSync(join(mirroredRoot, 'validate', 'nested-note.md'));

    const artifactPaths = (await ctx!.artifacts.list(run.uuid)).map(
      (artifact) => artifact.relativePath,
    );
    expect(artifactPaths).toContain('implementation-log.md');
    expect(artifactPaths).toContain('validate/nested-note.md');
    expect(existsSync(join(durableRoot, 'validate', 'nested-note.md'))).toBe(true);
  });
});

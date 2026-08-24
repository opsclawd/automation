import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeRoot, type ComposeOptions } from '../compose.js';
import { ValidateFixLoop, ReviewFixLoop, ImplementStepLoop } from '@ai-sdlc/application';
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

function fakeScript(exitCode: number): string {
  const dir = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-boundary-script-')));
  const scriptPath = path.join(dir, 'run.sh');
  writeFileSync(scriptPath, `#!/usr/bin/env bash\nexit ${exitCode}\n`, { mode: 0o755 });
  return scriptPath;
}

function makeAgentConfig(): object {
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

describe('ValidateFixLoop and ReviewFixLoop wiring in composeRoot', () => {
  it('wires git, readWorktreeFile, and artifactStore into ValidateFixLoop', async () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-boundary-')));
    const outsideDir = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-outside-')));
    const scriptPath = fakeScript(0);
    writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(makeAgentConfig()));

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
    });

    expect(container.validateFixLoop).toBeDefined();
    expect(container.validateFixLoop).toBeInstanceOf(ValidateFixLoop);

    const loopDeps = container.validateFixLoop!.deps;
    expect(loopDeps).toBeDefined();
    expect(loopDeps.git).toBeDefined();
    expect(loopDeps.git).toBe(container.git);

    expect(typeof loopDeps.readWorktreeFile).toBe('function');
    const testFile = 'test-file.txt';
    writeFileSync(path.join(root, testFile), 'manifest content');
    const readContent = await loopDeps.readWorktreeFile!(root, testFile);
    expect(readContent).toBe('manifest content');

    const missingContent = await loopDeps.readWorktreeFile!(root, 'nonexistent.txt');
    expect(missingContent).toBeUndefined();

    // Verify path traversal protection
    const outsideFile = path.join(outsideDir, 'secret.txt');
    writeFileSync(outsideFile, 'secret content');
    const traversalRelative = await loopDeps.readWorktreeFile!(root, '../outside.txt');
    expect(traversalRelative).toBeUndefined();

    const traversalAbsolute = await loopDeps.readWorktreeFile!(root, outsideFile);
    expect(traversalAbsolute).toBeUndefined();

    const traversalNested = await loopDeps.readWorktreeFile!(root, 'sub/../../outside.txt');
    expect(traversalNested).toBeUndefined();

    expect(loopDeps.artifactStore).toBeDefined();
    expect(typeof loopDeps.artifactStore?.read).toBe('function');
    expect(typeof loopDeps.artifactStore?.write).toBe('function');
  });

  it('wires git, readWorktreeFile, and artifactStore into ReviewFixLoop', async () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-boundary-')));
    const outsideDir = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-outside-')));
    const scriptPath = fakeScript(0);
    writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(makeAgentConfig()));

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
    });

    expect(container.reviewFixLoop).toBeDefined();
    expect(container.reviewFixLoop).toBeInstanceOf(ReviewFixLoop);

    const loopDeps = container.reviewFixLoop!.deps;
    expect(loopDeps).toBeDefined();
    expect(loopDeps.git).toBeDefined();
    expect(loopDeps.git).toBe(container.git);

    expect(typeof loopDeps.readWorktreeFile).toBe('function');
    const testFile = 'review-test-file.txt';
    writeFileSync(path.join(root, testFile), 'review manifest content');
    const readContent = await loopDeps.readWorktreeFile!(root, testFile);
    expect(readContent).toBe('review manifest content');

    const missingContent = await loopDeps.readWorktreeFile!(root, 'nonexistent.txt');
    expect(missingContent).toBeUndefined();

    // Verify path traversal protection
    const outsideFile = path.join(outsideDir, 'secret.txt');
    writeFileSync(outsideFile, 'secret content');
    const traversalRelative = await loopDeps.readWorktreeFile!(root, '../outside.txt');
    expect(traversalRelative).toBeUndefined();

    const traversalAbsolute = await loopDeps.readWorktreeFile!(root, outsideFile);
    expect(traversalAbsolute).toBeUndefined();

    const traversalNested = await loopDeps.readWorktreeFile!(root, 'sub/../../outside.txt');
    expect(traversalNested).toBeUndefined();

    expect(loopDeps.artifactStore).toBeDefined();
    expect(typeof loopDeps.artifactStore?.read).toBe('function');
    expect(typeof loopDeps.artifactStore?.write).toBe('function');
    expect(typeof loopDeps.revertScopeFiles).toBe('function');
  });

  it('artifactStore wired into ReviewFixLoop reads and writes through the worktree path resolution, falling back to repoRootPath when no worktree exists', async () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-boundary-')));
    const scriptPath = fakeScript(0);
    writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(makeAgentConfig()));

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
      repoFullName: 'owner/repo',
    });

    const run = {
      uuid: 'a1b2c3d4-0000-4000-8000-000000000001',
      displayId: 'issue-91-20260622-120000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 91,
      type: 'issue_to_pr' as const,
      status: 'running' as const,
      completedPhases: [],
      skippedPhases: [],
      startedAt: new Date('2026-06-22T12:00:00.000Z'),
    };
    container.runRepository.insertIfNoActive(run);

    const artifactStore = container.reviewFixLoop!.deps.artifactStore!;

    // No worktree at .ai-worktrees/issue-91 exists yet, so path resolution
    // must fall back to the repo root rather than throwing or writing nowhere.
    await artifactStore.write({
      runId: run.uuid,
      phaseId: 'review-fix',
      relativePath: 'fix-result.json',
      contents: '{"fixed":true}',
    });

    const readBack = await artifactStore.read(run.uuid, 'fix-result.json');
    expect(readBack).toBe('{"fixed":true}');
  });

  it('wires git, readWorktreeFile, and cleanArtifacts into ImplementStepLoop', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-boundary-')));
    const scriptPath = fakeScript(0);
    writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(makeAgentConfig()));

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
    });

    expect(container.implementStepLoop).toBeDefined();
    expect(container.implementStepLoop).toBeInstanceOf(ImplementStepLoop);

    const loopDeps = container.implementStepLoop!.deps;
    expect(loopDeps).toBeDefined();
    expect(loopDeps.git).toBeDefined();
    expect(loopDeps.git).toBe(container.git);
    expect(typeof loopDeps.readWorktreeFile).toBe('function');
    expect(typeof loopDeps.cleanArtifacts).toBe('function');
  });

  it('wires readWorktreeFile into buildPhaseHandlerContext', async () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-boundary-')));
    const scriptPath = fakeScript(0);
    writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(makeAgentConfig()));

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
    });

    const testFile = 'phase-ctx-file.txt';
    writeFileSync(path.join(root, testFile), 'manifest content for phase');

    const ctx = container.buildPhaseHandlerContext({
      runId: 'run-1',
      runUuid: '550e8400-e29b-41d4-a716-446655440000',
      repoFullName: 'owner/repo',
      issueNumber: 1,
      cwd: root,
      artifacts: container.artifactRepository,
      github: {} as unknown as import('@ai-sdlc/application').GitHubPort,
      git: container.git,
      agent: {} as unknown as import('@ai-sdlc/application').AgentPort,
      events: container.eventBus,
      now: () => new Date(),
    });

    expect(ctx.readWorktreeFile).toBeDefined();
    expect(typeof ctx.readWorktreeFile).toBe('function');
    const content = await ctx.readWorktreeFile!(root, testFile);
    expect(content).toBe('manifest content for phase');
  });

  it('wires deleteWorktreeFile into buildPhaseHandlerContext', async () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-boundary-delete-')));
    const scriptPath = fakeScript(0);
    writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(makeAgentConfig()));

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
    });

    const testFile = 'scratch-to-delete.txt';
    const filePath = path.join(root, testFile);
    writeFileSync(filePath, 'scratch file content');
    expect(existsSync(filePath)).toBe(true);

    const ctx = container.buildPhaseHandlerContext({
      runId: 'run-1',
      runUuid: '550e8400-e29b-41d4-a716-446655440000',
      repoFullName: 'owner/repo',
      issueNumber: 1,
      cwd: root,
      artifacts: container.artifactRepository,
      github: {} as unknown as import('@ai-sdlc/application').GitHubPort,
      git: container.git,
      agent: {} as unknown as import('@ai-sdlc/application').AgentPort,
      events: container.eventBus,
      now: () => new Date(),
    });

    expect(ctx.deleteWorktreeFile).toBeDefined();
    expect(typeof ctx.deleteWorktreeFile).toBe('function');
    const deleted = await ctx.deleteWorktreeFile!(root, testFile);
    expect(deleted).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });

  it('wires worktreeLifecycle and eventRepository into buildPhaseHandlerContext', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-boundary-lifecycle-')));
    const scriptPath = fakeScript(0);
    writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(makeAgentConfig()));

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
    });

    const ctx = container.buildPhaseHandlerContext({
      runId: 'run-1',
      runUuid: '550e8400-e29b-41d4-a716-446655440000',
      repoFullName: 'owner/repo',
      issueNumber: 1,
      cwd: root,
      artifacts: container.artifactRepository,
      github: {} as unknown as import('@ai-sdlc/application').GitHubPort,
      git: container.git,
      agent: {} as unknown as import('@ai-sdlc/application').AgentPort,
      events: container.eventBus,
      now: () => new Date(),
    });

    expect(ctx.worktreeLifecycle).toBeDefined();
    expect(typeof ctx.worktreeLifecycle?.inspect).toBe('function');
    expect(typeof ctx.worktreeLifecycle?.execute).toBe('function');

    expect(ctx.eventRepository).toBeDefined();
    expect(typeof ctx.eventRepository?.insert).toBe('function');

    expect(container.runExecutor).toBeDefined();
  });
});

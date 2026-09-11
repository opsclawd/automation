import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeRoot, type ComposeOptions } from '../compose.js';
import { ValidateFixLoop, extractResult } from '@ai-sdlc/application';
import {
  RepositoryId,
  AgentInvocationId,
  PhaseName,
  RunId,
  AgentProfileName,
} from '@ai-sdlc/domain';

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

  it('wires worktreeLifecycle into ResumeRun', () => {
    const root = trackDir(() =>
      mkdtempSync(path.join(os.tmpdir(), 'ai-orch-boundary-resumewire-')),
    );
    const scriptPath = fakeScript(0);
    writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(makeAgentConfig()));

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
    });

    expect(container.resumeRun).toBeDefined();
    expect(container.resumeRun.deps.worktreeLifecycle).toBeDefined();
    expect(typeof container.resumeRun.deps.worktreeLifecycle?.inspect).toBe('function');
    expect(typeof container.resumeRun.deps.worktreeLifecycle?.execute).toBe('function');
  });

  it('wires repair into buildPhaseHandlerContext', () => {
    const root = trackDir(() =>
      mkdtempSync(path.join(os.tmpdir(), 'ai-orch-boundary-repairwire-')),
    );
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

    expect(ctx.repair).toBeDefined();
    expect(typeof ctx.repair?.repairStructuredResult).toBe('function');
  });

  it('wires repair from compose context and successfully recovers an unescaped-quote artifact', async () => {
    const root = trackDir(() =>
      mkdtempSync(path.join(os.tmpdir(), 'ai-orch-boundary-repair-root-')),
    );
    const validJson = JSON.stringify({
      verdict: 'APPROVE',
      evaluations: [{ finding_id: 'f1', resolved: true, evidence: 'repaired successfully' }],
      new_findings: [],
      summary: 'All findings verified',
    });
    const scriptDir = trackDir(() =>
      mkdtempSync(path.join(os.tmpdir(), 'ai-orch-boundary-script-')),
    );
    const scriptPath = path.join(scriptDir, 'run.sh');
    writeFileSync(scriptPath, `#!/usr/bin/env bash\necho '${validJson}' > result.json\nexit 0\n`, {
      mode: 0o755,
    });

    const agentConfig = makeAgentConfig();
    (agentConfig as Record<string, unknown>).agent = {
      defaultProfile: 'test',
      profiles: {
        test: { runtime: 'opencode', provider: 'test', model: 'test', timeoutMinutes: 1 },
      },
      phaseProfiles: {
        'result-writer': { profile: 'test' },
        'follow-up-review': { profile: 'test' },
      },
    };
    writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(agentConfig));

    const fakeAgent: import('@ai-sdlc/application').AgentPort = {
      invoke: async (req) => {
        writeFileSync(path.join(req.cwd, 'result.json'), validJson);
        const outLog = path.join(req.cwd, 'repair-stdout.log');
        writeFileSync(outLog, 'repaired successfully');
        return {
          runtime: 'opencode',
          provider: 'test',
          model: 'test',
          exitCode: 0,
          durationMs: 10,
          stdoutPath: outLog,
          stderrPath: path.join(req.cwd, 'repair-stderr.log'),
          contractViolations: [],
          outcome: 'success',
        };
      },
    };

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
      agentAdapterOverrides: { opencode: fakeAgent },
    });

    const runUuid = '550e8400-e29b-41d4-a716-446655440000';
    container.runRepository.insertIfNoActive({
      uuid: runUuid,
      displayId: 'issue-1-20260622-120000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 1,
      type: 'issue_to_pr' as const,
      status: 'running' as const,
      completedPhases: [],
      skippedPhases: [],
      startedAt: new Date(),
    });

    const worktreeDir = trackDir(() =>
      mkdtempSync(path.join(os.tmpdir(), 'ai-orch-boundary-worktree-')),
    );
    const unescapedQuoteArtifact =
      '{\n  "verdict": "APPROVE",\n  "evaluations": [\n    {\n      "finding_id": "f1",\n      "resolved": true,\n      "evidence": "cites "unrepaired.key" identifier"\n    }\n  ],\n  "new_findings": [\n  malformed syntax that fails parse completely\n';
    writeFileSync(path.join(worktreeDir, 'result.json'), unescapedQuoteArtifact);

    const stdoutPath = path.join(worktreeDir, 'stdout.log');
    writeFileSync(stdoutPath, 'agent stdout with evidence showing work performed');

    container.agentInvocationRepository.insert({
      id: AgentInvocationId('inv-1'),
      runId: RunId(runUuid),
      phaseId: PhaseName('follow-up-review'),
      profile: AgentProfileName('test'),
      runtime: 'opencode',
      provider: 'test',
      model: 'test',
      promptPath: path.join(worktreeDir, 'prompt.md'),
      promptChars: 10,
      stdoutPath,
      stderrPath: path.join(worktreeDir, 'stderr.log'),
      startedAt: new Date(),
      startCommitSha: 'a'.repeat(40),
      timeoutMs: 60000,
    });

    const artifactsStore: import('@ai-sdlc/application').ArtifactStore = {
      read: async (_runId, rel) => readFileSync(path.join(worktreeDir, rel), 'utf-8'),
      write: async ({ relativePath, contents }) =>
        writeFileSync(path.join(worktreeDir, relativePath), contents),
      list: async () => [],
      hydrateWorktree: async () => {},
    };

    const ctx = container.buildPhaseHandlerContext({
      runId: 'run-1',
      runUuid: '550e8400-e29b-41d4-a716-446655440000',
      repoFullName: 'owner/repo',
      issueNumber: 1,
      cwd: worktreeDir,
      artifacts: artifactsStore,
      github: {} as unknown as import('@ai-sdlc/application').GitHubPort,
      git: container.git,
      agent: {} as unknown as import('@ai-sdlc/application').AgentPort,
      events: container.eventBus,
      now: () => new Date(),
    });

    expect(ctx.repair).toBeDefined();

    const outcome = await extractResult({
      invocation: {
        id: AgentInvocationId('inv-1'),
        runId: '550e8400-e29b-41d4-a716-446655440000',
        phaseId: PhaseName('follow-up-review'),
        attempt: 1,
        profile: AgentProfileName('test'),
        cwd: worktreeDir,
        startedAt: new Date(),
        completedAt: new Date(),
        exitCode: 0,
        status: 'completed',
        stdoutPath,
        stderrPath: path.join(worktreeDir, 'stderr.log'),
        resultJsonPath: 'result.json',
        startCommitSha: 'a'.repeat(40),
      },
      ports: {
        artifacts: ctx.artifacts,
        repair: ctx.repair,
      },
      cwd: worktreeDir,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toMatchObject({ verdict: 'APPROVE' });
    }
  });

  it('wires selfVerifyCommands into buildPhaseHandlerContext and ImplementHandler when defined in config', () => {
    const root = trackDir(() =>
      mkdtempSync(path.join(os.tmpdir(), 'ai-orch-boundary-self-verify-')),
    );
    const scriptPath = fakeScript(0);
    const cfg = makeAgentConfig();
    cfg.validation.selfVerifyCommands = ['pnpm typecheck', 'pnpm lint'];
    writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(cfg));

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

    expect(ctx.selfVerifyCommands).toEqual(['pnpm typecheck', 'pnpm lint']);

    const implementHandler = container.phaseRegistry.get(PhaseName('implement')) as unknown as {
      opts: {
        selfVerifyCommands?: string[];
      };
    };
    expect(implementHandler.opts.selfVerifyCommands).toEqual(['pnpm typecheck', 'pnpm lint']);
  });
});

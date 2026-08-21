import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { CompoundHandler } from '../compound.js';
import { FakeAgentPort } from '../../../test-doubles/fake-agent-port.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import { FakeGitHubPort } from '../../../test-doubles/fake-github-port.js';
import type { AgentInvocationResult } from '../../../ports/agent-invocation-types.js';
import type { PhaseHandlerContext } from '../../handler.js';

const { mockLoadPromptTemplate, mockRenderPrompt } = vi.hoisted(() => ({
  mockLoadPromptTemplate: vi.fn<[string, string, { promptsRoot: string }], string>(),
  mockRenderPrompt: vi.fn<
    [
      string,
      { runId: string; vars: Record<string, string>; artifacts: PhaseHandlerContext['artifacts'] },
    ],
    Promise<string>
  >(),
}));

vi.mock('../../../prompts/load-prompt-template.js', () => ({
  loadPromptTemplate: mockLoadPromptTemplate,
}));

vi.mock('../../../prompts/render-prompt.js', () => ({
  renderPrompt: mockRenderPrompt,
}));

function successResult(overrides?: Partial<AgentInvocationResult>): AgentInvocationResult {
  return {
    runtime: 'opencode',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    exitCode: 0,
    durationMs: 5000,
    stdoutPath: '/tmp/stdout',
    stderrPath: '/tmp/stderr',
    resultJsonPath: 'result.json',
    contractViolations: [],
    outcome: 'success',
    ...overrides,
  };
}

const RUN_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('CompoundHandler scratch file remediation (regression #948)', () => {
  let tmpCwd: string;
  let artifacts: FakeArtifactStore;
  let git: FakeGitPort;
  let agent: FakeAgentPort;
  let events: OrchestratorEvent[];
  let ctx: PhaseHandlerContext;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    tmpCwd = mkdtempSync(join(tmpdir(), 'compound-scratch-test-'));
    artifacts = new FakeArtifactStore();
    git = new FakeGitPort();
    agent = new FakeAgentPort();
    events = [];

    git.currentBranchByCwd.set(tmpCwd, 'main');
    git.headByCwd.set(tmpCwd, 'sha-before');
    mockLoadPromptTemplate.mockReturnValue('# Learnings');
    mockRenderPrompt.mockResolvedValue('# Learnings for 42');

    ctx = {
      runId: 'run-1',
      runUuid: RUN_UUID,
      repoFullName: 'acme/widgets',
      issueNumber: 42,
      cwd: tmpCwd,
      artifacts,
      github: new FakeGitHubPort(),
      git,
      agent,
      events: {
        publish: (_u: string, e: OrchestratorEvent) => {
          events.push(e);
        },
        subscribe: () => () => {},
      },
      now: () => new Date('2026-08-19T00:00:00.000Z'),
      promptsRoot: '/tmp/prompts',
      startCommitSha: 'sha-before',
      expectedBranch: 'main',
      baseBranch: 'main',
      resolveProfile: () => 'pi-qwen-local',
      idFactory: () => 'inv-001',
      deleteWorktreeFile: async (cwd: string, rel: string) => {
        try {
          const p = join(cwd, rel);
          if (existsSync(p)) {
            rmSync(p);
            return true;
          }
          return false;
        } catch {
          return false;
        }
      },
    } as unknown as PhaseHandlerContext;

    await artifacts.write({
      runId: RUN_UUID,
      phaseId: 'plan_write',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [{ n: 1, title: 'Task 1', expected_files: ['src/feature/declared.ts'] }],
      }),
    });

    await artifacts.write({
      runId: RUN_UUID,
      relativePath: 'result.json',
      contents: JSON.stringify({ result: 'written', path: 'compound.md', summary: 'ok' }),
    });
    await artifacts.write({
      runId: RUN_UUID,
      relativePath: 'compound.md',
      contents: '# Learnings\n',
    });
  });

  it('remediates undeclared untracked root-level scratch file (get_diff.sh), writes report, and completes successfully', async () => {
    try {
      const scratchFile = join(tmpCwd, 'get_diff.sh');
      writeFileSync(scratchFile, '#!/bin/bash\ngit diff');

      agent.enqueue('pi-qwen-local', () => {
        git.headByCwd.set(tmpCwd, 'sha-before');
        return successResult();
      });

      git.status = vi.fn(async () => {
        return existsSync(scratchFile) ? '?? get_diff.sh\n' : '';
      });

      const handler = new CompoundHandler();
      const result = await handler.run(ctx);

      expect(result.outcome).toBe('passed');
      expect(existsSync(scratchFile)).toBe(false);

      const artifactContent = await artifacts.read(RUN_UUID, '.ai-tmp/scratch-files.json');
      const parsed = JSON.parse(artifactContent);
      expect(parsed.steps).toContainEqual(
        expect.objectContaining({
          phaseId: 'compound',
          stepTitle: 'compound',
          files: ['get_diff.sh'],
        }),
      );
      expect(events.filter((e) => e.type === 'compound.completed')).toHaveLength(1);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('records subdirectory untracked files in scratch artifact without deleting them and fails boundary check', async () => {
    const pkgDir = join(tmpCwd, 'packages', 'contracts');
    mkdirSync(pkgDir, { recursive: true });
    const subScratch = join(pkgDir, 'scratch.ts');
    writeFileSync(subScratch, 'export const probe = 1;');

    try {
      agent.enqueue('pi-qwen-local', () => {
        git.headByCwd.set(tmpCwd, 'sha-before');
        return successResult();
      });

      git.status = vi.fn(async () => {
        return existsSync(subScratch) ? '?? packages/contracts/scratch.ts\n' : '';
      });

      const handler = new CompoundHandler();
      const result = await handler.run(ctx);

      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.failure.kind).toBe('validation_failed');
        expect(result.failure.message).toContain(
          'compound phase modified undeclared files: packages/contracts/scratch.ts',
        );
      }

      // Subdirectory file must NOT be deleted from disk
      expect(existsSync(subScratch)).toBe(true);

      // Recorded in scratch artifact
      const artifactContent = await artifacts.read(RUN_UUID, '.ai-tmp/scratch-files.json');
      const parsed = JSON.parse(artifactContent);
      expect(parsed.steps).toContainEqual(
        expect.objectContaining({
          phaseId: 'compound',
          stepTitle: 'compound',
          files: ['packages/contracts/scratch.ts'],
        }),
      );

      expect(events.filter((e) => e.type === 'compound.boundary_violation')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'compound.failed')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'compound.completed')).toHaveLength(0);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('does not delete protected files and fails boundary check', async () => {
    const gitignoreFile = join(tmpCwd, '.gitignore');
    writeFileSync(gitignoreFile, '# gitignore');

    try {
      agent.enqueue('pi-qwen-local', () => {
        git.headByCwd.set(tmpCwd, 'sha-before');
        return successResult();
      });

      git.status = vi.fn(async () => {
        return existsSync(gitignoreFile) ? '?? .gitignore\n' : '';
      });

      const handler = new CompoundHandler();
      const result = await handler.run(ctx);

      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.failure.kind).toBe('validation_failed');
        expect(result.failure.message).toContain(
          'compound phase modified undeclared files: .gitignore',
        );
      }

      // Protected file must NOT be deleted from disk
      expect(existsSync(gitignoreFile)).toBe(true);

      expect(events.filter((e) => e.type === 'compound.boundary_violation')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'compound.failed')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'compound.completed')).toHaveLength(0);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('fails boundary check when tracked files are modified outside boundaries', async () => {
    agent.enqueue('pi-qwen-local', () => {
      git.headByCwd.set(tmpCwd, 'sha-after');
      return successResult();
    });

    git.changedFilesResults.set('sha-before|sha-after', ['src/undeclared.ts']);

    const handler = new CompoundHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('validation_failed');
      expect(result.failure.message).toContain(
        'compound phase modified undeclared files: src/undeclared.ts',
      );
    }

    expect(events.filter((e) => e.type === 'compound.boundary_violation')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'compound.failed')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'compound.completed')).toHaveLength(0);
  });

  it('does not report or delete orchestrator artifacts at root even if untracked', async () => {
    try {
      const planFile = join(tmpCwd, 'plan.md');
      const compoundFile = join(tmpCwd, 'compound.md');
      const manifestFile = join(tmpCwd, 'task-manifest.json');
      const resultFile = join(tmpCwd, 'result.json');

      writeFileSync(planFile, '# Plan');
      writeFileSync(compoundFile, '# Compound');
      writeFileSync(manifestFile, '{}');
      writeFileSync(resultFile, '{}');

      agent.enqueue('pi-qwen-local', () => {
        git.headByCwd.set(tmpCwd, 'sha-before');
        return successResult();
      });

      git.status = vi.fn(async () => {
        return '?? plan.md\n?? compound.md\n?? task-manifest.json\n?? result.json\n';
      });

      const handler = new CompoundHandler();
      const result = await handler.run(ctx);

      expect(result.outcome).toBe('passed');
      expect(existsSync(planFile)).toBe(true);
      expect(existsSync(compoundFile)).toBe(true);
      expect(existsSync(manifestFile)).toBe(true);
      expect(existsSync(resultFile)).toBe(true);

      expect(events.filter((e) => e.type === 'compound.scratch_files_left')).toHaveLength(0);
      expect(events.filter((e) => e.type === 'compound.completed')).toHaveLength(1);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('merges with pre-existing step reports in .ai-tmp/scratch-files.json', async () => {
    try {
      await artifacts.write({
        runId: RUN_UUID,
        relativePath: '.ai-tmp/scratch-files.json',
        contents: JSON.stringify({
          steps: [
            {
              phaseId: 'implement',
              stepIndex: 1,
              totalSteps: 1,
              stepTitle: 'Task 1',
              files: ['implement-scratch.js'],
            },
          ],
        }),
      });

      const scratchFile = join(tmpCwd, 'compound_helper.sh');
      writeFileSync(scratchFile, '#!/bin/bash\necho helper');

      agent.enqueue('pi-qwen-local', () => {
        git.headByCwd.set(tmpCwd, 'sha-before');
        return successResult();
      });

      git.status = vi.fn(async () => {
        return existsSync(scratchFile) ? '?? compound_helper.sh\n' : '';
      });

      const handler = new CompoundHandler();
      const result = await handler.run(ctx);

      expect(result.outcome).toBe('passed');
      expect(existsSync(scratchFile)).toBe(false);

      const artifactContent = await artifacts.read(RUN_UUID, '.ai-tmp/scratch-files.json');
      const parsed = JSON.parse(artifactContent);
      expect(parsed.steps).toHaveLength(2);
      expect(parsed.steps[0]).toEqual({
        phaseId: 'implement',
        stepIndex: 1,
        totalSteps: 1,
        stepTitle: 'Task 1',
        files: ['implement-scratch.js'],
      });
      expect(parsed.steps[1]).toEqual({
        phaseId: 'compound',
        stepIndex: 0,
        totalSteps: 1,
        stepTitle: 'compound',
        files: ['compound_helper.sh'],
      });
      expect(events.filter((e) => e.type === 'compound.completed')).toHaveLength(1);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { composeRoot, type Container } from '../compose.js';
import { buildServer } from '../server.js';
import { WorkerId, RunId, RepositoryId, type Run } from '@ai-sdlc/domain';
import {
  workerLoop,
  type AgentPort,
  type AgentInvocationRequest,
  type AgentInvocationResult,
  type PhaseHandlerContext,
} from '@ai-sdlc/application';

interface ScriptedAgentScript {
  phaseId?: string;
  invocationType?: string;
  handle: (
    request: AgentInvocationRequest,
  ) => AgentInvocationResult | Promise<AgentInvocationResult>;
}

class ScriptedAgentPort implements AgentPort {
  readonly invocations: AgentInvocationRequest[] = [];
  private readonly scripts: Map<string, ScriptedAgentScript['handle']>;

  constructor(scripts: ScriptedAgentScript[] = []) {
    this.scripts = new Map();
    for (const script of scripts) {
      if (script.invocationType) {
        const key = `${script.phaseId ?? ''}:${script.invocationType}`;
        this.scripts.set(key, script.handle);
      } else {
        const key = `${script.phaseId ?? ''}:*`;
        this.scripts.set(key, script.handle);
      }
    }
  }

  async invoke(input: AgentInvocationRequest): Promise<AgentInvocationResult> {
    this.invocations.push(input);
    const keyWithInv = `${input.phaseId}:${String(input.metadata?.invocation_type ?? 'initial')}`;
    const keyPhaseOnly = `${input.phaseId}:*`;
    const handler = this.scripts.get(keyWithInv) ?? this.scripts.get(keyPhaseOnly);
    if (!handler) {
      return {
        runtime: 'test' as const,
        provider: 'test',
        model: 'test',
        exitCode: 0,
        durationMs: 10,
        stdoutPath: '/dev/null',
        stderrPath: '/dev/null',
        contractViolations: [],
        outcome: 'success' as const,
      };
    }
    return handler(input);
  }
}

interface TestHarness {
  container: Container;
  app: Awaited<ReturnType<typeof buildServer>>;
  run: Run;
  context: PhaseHandlerContext;
  targetRoot: string;
  worktreeDir: string;
  automationRoot: string;
  scriptedInvocations: AgentInvocationRequest[];
  cleanup: () => Promise<void>;
}

function initGitRepo(repoPath: string, identity: { name: string; email: string }): void {
  execFileSync('git', ['init'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', identity.name], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', identity.email], { cwd: repoPath });
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: repoPath });

  const baselineGitignore = [
    '# Orchestrator run artifacts',
    '/task-manifest.json',
    '/design.md',
    '/plan.md',
    '/prompt.md',
    '/implementation-log.md',
    '/result.json',
    '/plan-review-findings.md',
    '/plan-fix-result.json',
    '/quality-review-result.*.json',
    '/spec-review-result.*.json',
    '/fix-result.json',
    '',
  ].join('\n');

  writeFileSync(path.join(repoPath, '.gitignore'), baselineGitignore);
  writeFileSync(path.join(repoPath, 'README.md'), '# Baseline\n');
  writeFileSync(
    path.join(repoPath, 'package.json'),
    JSON.stringify({
      name: 'harness-target',
      private: true,
      scripts: { build: 'exit 0', typecheck: 'exit 0', lint: 'exit 0' },
    }),
  );
  writeFileSync(
    path.join(repoPath, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n`,
  );
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'chore: initial baseline'], { cwd: repoPath });
}

async function createHarness(opts: {
  repoFullName?: string;
  issueNumber?: number;
  scripts?: ScriptedAgentScript[];
}): Promise<TestHarness> {
  const repoFullName = opts.repoFullName ?? 'owner/test-repo';
  const issueNumber = opts.issueNumber ?? 1;

  const automationRoot = mkdtempSync(path.join(tmpdir(), 'ai-resume-lifecycle-'));
  const targetRoot = path.join(automationRoot, 'target');
  const runsDir = path.join(targetRoot, '.ai-runs');
  const dbPath = path.join(automationRoot, 'orch.sqlite');
  const worktreeRoot = path.join(targetRoot, '.ai-worktrees');
  const baseTmpDir = path.join(automationRoot, 'tmp');

  mkdirSync(targetRoot, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(baseTmpDir, { recursive: true });

  initGitRepo(targetRoot, { name: 'Test User', email: 'test@example.com' });

  // Copy plan-review prompt templates so renderPrompt succeeds
  const planReviewPromptsRoot = path.join(targetRoot, 'prompts', 'plan-review');
  mkdirSync(planReviewPromptsRoot, { recursive: true });

  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const repoPromptsDir = path.join(selfDir, '..', '..', '..', '..', 'prompts');
  try {
    const planReviewSrc = path.join(repoPromptsDir, 'plan-review', 'plan-review.md');
    const planFixSrc = path.join(repoPromptsDir, 'plan-review', 'plan-fix.md');
    if (existsSync(planReviewSrc)) {
      writeFileSync(
        path.join(planReviewPromptsRoot, 'plan-review.md'),
        readFileSync(planReviewSrc, 'utf-8'),
      );
    }
    if (existsSync(planFixSrc)) {
      writeFileSync(
        path.join(planReviewPromptsRoot, 'plan-fix.md'),
        readFileSync(planFixSrc, 'utf-8'),
      );
    }
  } catch {}

  const agentConfig = {
    validation: { commands: ['exit 0'], timeout: 60 },
    phases: {
      skip: ['validate', 'fix-validate', 'review-fix', 'compound', 'create-pr', 'post-pr-review'],
      planReview: { enabled: true, maxIterations: 2 },
      reviewFix: { maxIterations: 2 },
      implement: {
        maxIterations: 2,
        exemptUndeclaredFiles: ['pnpm-lock.yaml', 'plan.md', 'design.md'],
      },
      fixValidate: { enabled: false, maxIterations: 3 },
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
    agent: {
      defaultProfile: 'test',
      profiles: {
        test: { runtime: 'opencode', provider: 'test', model: 'test', timeoutMinutes: 1 },
      },
      phaseProfiles: {
        'plan-review': { profile: 'test' },
        'plan-fix': { profile: 'test' },
        implement: { profile: 'test' },
        'spec-review': { profile: 'test' },
        'quality-review': { profile: 'test' },
        arbiter: { profile: 'test' },
        'result-writer': { profile: 'test' },
        'whole-pr-review': { profile: 'test' },
        'fix-review': { profile: 'test' },
      },
    },
  };

  writeFileSync(path.join(targetRoot, '.ai-orchestrator.json'), JSON.stringify(agentConfig));
  execFileSync('git', ['add', '.'], { cwd: targetRoot });
  execFileSync('git', ['commit', '-m', 'chore: orchestrator config'], { cwd: targetRoot });

  const scriptPath = path.join(automationRoot, 'fake.sh');
  writeFileSync(scriptPath, '#!/usr/bin/env bash\necho ok\nexit 0\n');
  execFileSync('chmod', ['+x', scriptPath]);

  const scriptedAgent = new ScriptedAgentPort(opts.scripts ?? []);

  const container = composeRoot({
    repoRoot: targetRoot,
    scriptPath,
    dbPath,
    runsDir,
    baseTmpDir,
    repoFullName,
    agentAdapterOverrides: {
      opencode: scriptedAgent,
    },
  });

  const [owner, repoName] = repoFullName.split('/');
  const repoId = RepositoryId(createHash('sha256').update(repoFullName).digest('hex'));

  container.repositoryRegistry.insert({
    id: repoId,
    fullName: repoFullName,
    owner: owner ?? 'owner',
    name: repoName ?? 'repo',
    localBasePath: targetRoot,
    defaultBranch: 'main',
    remoteUrl: `git@github.com:${repoFullName}.git`,
    enabled: true,
    maxConcurrentRuns: 1,
    healthStatus: 'healthy' as const,
    healthError: null,
    lastHealthCheckAt: new Date(),
    configMetadata: '{}',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const runUuid = randomUUID();
  const displayId = `issue-${issueNumber}-${runUuid}`;

  const runRecord: Run = {
    uuid: runUuid,
    displayId,
    repoId,
    issueNumber,
    type: 'issue_to_pr',
    status: 'running',
    completedPhases: [],
    skippedPhases: [
      'validate',
      'fix-validate',
      'review-fix',
      'compound',
      'create-pr',
      'post-pr-review',
    ],
    startedAt: new Date(),
  };

  container.runRepository.insertIfNoActive(runRecord);

  const context = container.buildRunContext!(runRecord);
  const worktreeDir = path.join(worktreeRoot, `issue-${issueNumber}`);

  const app = await buildServer(container, false);

  const cleanup = async () => {
    try {
      await app.close();
    } catch {}
    try {
      rmSync(automationRoot, { recursive: true, force: true });
    } catch {}
  };

  return {
    container,
    app,
    run: runRecord,
    context,
    targetRoot,
    worktreeDir,
    automationRoot,
    scriptedInvocations: scriptedAgent.invocations,
    cleanup,
  };
}

const activeHarnesses: TestHarness[] = [];

afterEach(async () => {
  while (activeHarnesses.length > 0) {
    const h = activeHarnesses.pop();
    if (h) {
      await h.cleanup();
    }
  }
});

function trackHarness(h: TestHarness): TestHarness {
  activeHarnesses.push(h);
  return h;
}

describe('resume worktree lifecycle integration', () => {
  it('round-trips queued reset disposition into audited baseline recovery', async () => {
    // 1. Setup composed harness with implement passing script
    const implementScript: ScriptedAgentScript = {
      phaseId: 'implement',
      handle: async (request) => {
        mkdirSync(path.join(request.cwd, 'src'), { recursive: true });
        writeFileSync(path.join(request.cwd, 'src', 'task1.ts'), 'export const task1 = 2;\n');
        execFileSync('git', ['add', '.'], { cwd: request.cwd });
        execFileSync('git', ['commit', '-m', 'feat: task 1 implemented'], { cwd: request.cwd });
        return {
          runtime: 'test' as const,
          provider: 'test',
          model: 'test',
          exitCode: 0,
          durationMs: 10,
          stdoutPath: '/dev/null',
          stderrPath: '/dev/null',
          contractViolations: [],
          outcome: 'success' as const,
        };
      },
    };

    const specReviewScript: ScriptedAgentScript = {
      phaseId: 'spec-review',
      handle: async (request) => {
        writeFileSync(
          path.join(request.cwd, 'result.json'),
          JSON.stringify({ result: 'pass', reviewType: 'spec', findings: [] }),
        );
        return {
          runtime: 'test' as const,
          provider: 'test',
          model: 'test',
          exitCode: 0,
          durationMs: 10,
          stdoutPath: '/dev/null',
          stderrPath: '/dev/null',
          contractViolations: [],
          outcome: 'success' as const,
        };
      },
    };

    const qualityReviewScript: ScriptedAgentScript = {
      phaseId: 'quality-review',
      handle: async (request) => {
        writeFileSync(
          path.join(request.cwd, 'result.json'),
          JSON.stringify({ result: 'pass', reviewType: 'quality', findings: [] }),
        );
        return {
          runtime: 'test' as const,
          provider: 'test',
          model: 'test',
          exitCode: 0,
          durationMs: 10,
          stdoutPath: '/dev/null',
          stderrPath: '/dev/null',
          contractViolations: [],
          outcome: 'success' as const,
        };
      },
    };

    const harness = trackHarness(
      await createHarness({
        scripts: [implementScript, specReviewScript, qualityReviewScript],
      }),
    );

    // 2. Initialize worktree as an independent branch ai/issue-1
    execFileSync(
      'git',
      ['worktree', 'add', '-b', `ai/issue-${harness.run.issueNumber}`, harness.worktreeDir, 'main'],
      { cwd: harness.targetRoot },
    );

    // Create baseline commit on ai/issue-1
    mkdirSync(path.join(harness.worktreeDir, 'src'), { recursive: true });
    writeFileSync(path.join(harness.worktreeDir, 'src', 'task1.ts'), 'export const task1 = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: harness.worktreeDir });
    execFileSync('git', ['commit', '-m', 'feat: baseline commit for task 1'], {
      cwd: harness.worktreeDir,
    });
    const baselineSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: harness.worktreeDir,
      encoding: 'utf8',
    }).trim();

    // Now simulate an interrupted step that drifted HEAD and left dirty worktree residue
    writeFileSync(
      path.join(harness.worktreeDir, 'src', 'stale.ts'),
      'export const stale = true;\n',
    );
    execFileSync('git', ['add', '.'], { cwd: harness.worktreeDir });
    execFileSync('git', ['commit', '-m', 'wip: incomplete drifted attempt commit'], {
      cwd: harness.worktreeDir,
    });

    // Uncommitted dirty files: tracked modification + untracked files
    writeFileSync(path.join(harness.worktreeDir, 'README.md'), '# Modified drifted README\n');
    writeFileSync(
      path.join(harness.worktreeDir, 'stale-uncommitted.ts'),
      'stale uncommitted code\n',
    );
    writeFileSync(path.join(harness.worktreeDir, 'scratch-probe.tmp'), 'scratch probe data\n');

    // 3. Durable state: run was failed during implement
    harness.container.runRepository.update(harness.run.uuid, {
      status: 'failed',
      currentPhase: 'implement',
      completedPhases: ['read_issue', 'plan-design', 'plan-write', 'plan-review'],
    });

    harness.container.phaseRepository.insert({
      id: 'phase-read-issue',
      runUuid: harness.run.uuid,
      name: 'read_issue',
      status: 'passed',
      attempt: 1,
      startedAt: new Date(),
      completedAt: new Date(),
    });
    harness.container.phaseRepository.insert({
      id: 'phase-plan-design',
      runUuid: harness.run.uuid,
      name: 'plan-design',
      status: 'passed',
      attempt: 1,
      startedAt: new Date(),
      completedAt: new Date(),
    });
    harness.container.phaseRepository.insert({
      id: 'phase-plan-write',
      runUuid: harness.run.uuid,
      name: 'plan-write',
      status: 'passed',
      attempt: 1,
      startedAt: new Date(),
      completedAt: new Date(),
    });
    harness.container.phaseRepository.insert({
      id: 'phase-plan-review',
      runUuid: harness.run.uuid,
      name: 'plan-review',
      status: 'passed',
      attempt: 1,
      startedAt: new Date(),
      completedAt: new Date(),
    });
    harness.container.phaseRepository.insert({
      id: 'phase-implement',
      runUuid: harness.run.uuid,
      name: 'implement',
      status: 'failed',
      attempt: 1,
      startedAt: new Date(),
    });

    // Durable step with recorded initialPreStepHead = baselineSha
    harness.container.stepRepository.upsert({
      id: `step-${harness.run.uuid}-1`,
      runId: harness.run.uuid,
      phaseId: 'implement',
      index: 1,
      title: 'Task 1: First Task',
      status: 'failed',
      initialPreStepHead: baselineSha,
      revertCounts: {},
    });

    // Durable artifacts
    await harness.context.artifacts.write({
      runId: harness.run.uuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: '# Issue 1\n',
    });
    await harness.context.artifacts.write({
      runId: harness.run.uuid,
      phaseId: 'read_issue',
      relativePath: 'issue-comments.md',
      contents: '[]\n',
    });
    await harness.context.artifacts.write({
      runId: harness.run.uuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n',
    });
    await harness.context.artifacts.write({
      runId: harness.run.uuid,
      phaseId: 'plan-write',
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: First Task\nImplement task 1\n',
    });
    await harness.context.artifacts.write({
      runId: harness.run.uuid,
      phaseId: 'plan-write',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [{ n: 1, title: 'First Task' }],
      }),
    });
    await harness.context.artifacts.write({
      runId: harness.run.uuid,
      phaseId: 'plan-review',
      relativePath: 'plan-review-findings.md',
      contents: '## verdict\npass\n\n## findings\n',
    });
    await harness.context.artifacts.write({
      runId: harness.run.uuid,
      phaseId: 'plan-review',
      relativePath: 'plan-review-passed.marker',
      contents: '',
    });

    // Ensure plan.md is deleted from worktree to test rehydration
    try {
      rmSync(path.join(harness.worktreeDir, 'plan.md'), { force: true });
    } catch {}
    expect(existsSync(path.join(harness.worktreeDir, 'plan.md'))).toBe(false);

    // 4. API resume request without explicit disposition (defaults to reset_to_baseline)
    // Providing confirm: true for unsafe implement resume phase and x-repository-id header
    const apiRes = await harness.app.inject({
      method: 'POST',
      url: `/api/runs/${harness.run.uuid}/resume`,
      headers: {
        'x-repository-id': String(harness.run.repoId),
      },
      payload: { confirm: true },
    });

    expect(apiRes.statusCode).toBe(202);
    const apiBody = apiRes.json();
    expect(apiBody.action).toBe('resume');
    expect(apiBody.job).toBeDefined();
    expect(apiBody.job.resumeDisposition).toBe('reset_to_baseline');

    // 5. Worker consumes the job from SQLite queue and executes
    const workerId = WorkerId('worker-test-1');
    harness.container.workerRegistry!.register({
      id: workerId,
      repoId: harness.run.repoId,
      hostname: os.hostname(),
      processId: process.pid,
      status: 'idle',
      registeredAt: new Date(),
      heartbeatAt: new Date(),
    });

    const workerDeps = harness.container.workerLoopDeps!(harness.run.repoId);
    await workerLoop(workerId, {
      ...workerDeps,
      now: () => new Date(),
      ttlMs: 60_000,
    });

    // 6. Assertions:
    // a. Pre-reset audit row was synchronously inserted into eventRepository before Git mutation
    const allEvents = harness.container.eventRepository.listByRunSince(
      RunId(harness.run.uuid),
      new Date(0),
    );
    const resetAuditEvent = allEvents.find((e) => e.type === 'run.resume_worktree_reset');
    expect(resetAuditEvent).toBeDefined();
    expect(resetAuditEvent!.metadata?.baseline).toBe(baselineSha);
    expect(resetAuditEvent!.metadata?.stepIndex).toBe(1);
    expect(resetAuditEvent!.phase).toBe('implement');

    const discardedPaths = (resetAuditEvent!.metadata?.discardedPaths as string[]) ?? [];
    expect(discardedPaths).toContain('stale-uncommitted.ts');
    expect(discardedPaths).toContain('scratch-probe.tmp');

    // b. Worktree was reset to baseline: stale uncommitted files removed, drifted commit undone
    expect(existsSync(path.join(harness.worktreeDir, 'stale-uncommitted.ts'))).toBe(false);
    expect(existsSync(path.join(harness.worktreeDir, 'scratch-probe.tmp'))).toBe(false);
    expect(existsSync(path.join(harness.worktreeDir, 'src', 'stale.ts'))).toBe(false);
    expect(readFileSync(path.join(harness.worktreeDir, 'README.md'), 'utf-8')).toBe('# Baseline\n');

    // c. Durable artifacts survived and rehydrated into worktree
    expect(existsSync(path.join(harness.worktreeDir, 'plan.md'))).toBe(true);
    expect(readFileSync(path.join(harness.worktreeDir, 'plan.md'), 'utf-8')).toContain(
      '## Task 1: First Task',
    );

    // d. Implement phase entered and completed successfully
    const finalRun = harness.container.runRepository.findByUuid(harness.run.uuid);
    expect(finalRun?.status).toBe('passed');
  }, 30_000);

  it('preserves only explicitly approved operator repairs', async () => {
    // -------------------------------------------------------------
    // Part A: In-scope dirty operator repair survives and reaches implement
    // -------------------------------------------------------------
    const implementScriptA: ScriptedAgentScript = {
      phaseId: 'implement',
      handle: async (request) => {
        // Assert that operator repair in src/task1.ts is still intact when implement agent runs
        const task1Content = readFileSync(path.join(request.cwd, 'src', 'task1.ts'), 'utf-8');
        expect(task1Content).toContain('// operator repair: in-scope fix for task 1');

        execFileSync('git', ['add', 'src/task1.ts'], { cwd: request.cwd });
        execFileSync('git', ['commit', '-m', 'implement: task 1 finished with operator repair'], {
          cwd: request.cwd,
        });

        return {
          runtime: 'test' as const,
          provider: 'test',
          model: 'test',
          exitCode: 0,
          durationMs: 10,
          stdoutPath: '/dev/null',
          stderrPath: '/dev/null',
          contractViolations: [],
          outcome: 'success' as const,
        };
      },
    };

    const reviewScripts: ScriptedAgentScript[] = [
      {
        phaseId: 'spec-review',
        handle: async (request) => {
          writeFileSync(
            path.join(request.cwd, 'result.json'),
            JSON.stringify({ result: 'pass', reviewType: 'spec', findings: [] }),
          );
          return {
            runtime: 'test' as const,
            provider: 'test',
            model: 'test',
            exitCode: 0,
            durationMs: 10,
            stdoutPath: '/dev/null',
            stderrPath: '/dev/null',
            contractViolations: [],
            outcome: 'success' as const,
          };
        },
      },
      {
        phaseId: 'quality-review',
        handle: async (request) => {
          writeFileSync(
            path.join(request.cwd, 'result.json'),
            JSON.stringify({ result: 'pass', reviewType: 'quality', findings: [] }),
          );
          return {
            runtime: 'test' as const,
            provider: 'test',
            model: 'test',
            exitCode: 0,
            durationMs: 10,
            stdoutPath: '/dev/null',
            stderrPath: '/dev/null',
            contractViolations: [],
            outcome: 'success' as const,
          };
        },
      },
    ];

    const harnessA = trackHarness(
      await createHarness({
        scripts: [implementScriptA, ...reviewScripts],
      }),
    );

    execFileSync(
      'git',
      [
        'worktree',
        'add',
        '-b',
        `ai/issue-${harnessA.run.issueNumber}`,
        harnessA.worktreeDir,
        'main',
      ],
      { cwd: harnessA.targetRoot },
    );

    mkdirSync(path.join(harnessA.worktreeDir, 'src'), { recursive: true });
    writeFileSync(path.join(harnessA.worktreeDir, 'src', 'task1.ts'), 'export const task1 = 0;\n');
    execFileSync('git', ['add', '.'], { cwd: harnessA.worktreeDir });
    execFileSync('git', ['commit', '-m', 'baseline commit'], { cwd: harnessA.worktreeDir });
    const baselineShaA = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: harnessA.worktreeDir,
      encoding: 'utf8',
    }).trim();

    // Operator makes an in-scope repair to src/task1.ts
    writeFileSync(
      path.join(harnessA.worktreeDir, 'src', 'task1.ts'),
      '// operator repair: in-scope fix for task 1\nexport const task1 = 42;\n',
    );

    // Set run to needs_human_review with incomplete implement step
    harnessA.container.runRepository.update(harnessA.run.uuid, {
      status: 'needs_human_review',
      currentPhase: 'implement',
      completedPhases: ['read_issue', 'plan-design', 'plan-write', 'plan-review'],
    });

    harnessA.container.phaseRepository.insert({
      id: 'phase-read-issue-a',
      runUuid: harnessA.run.uuid,
      name: 'read_issue',
      status: 'passed',
      attempt: 1,
      startedAt: new Date(),
      completedAt: new Date(),
    });
    harnessA.container.phaseRepository.insert({
      id: 'phase-plan-design-a',
      runUuid: harnessA.run.uuid,
      name: 'plan-design',
      status: 'passed',
      attempt: 1,
      startedAt: new Date(),
      completedAt: new Date(),
    });
    harnessA.container.phaseRepository.insert({
      id: 'phase-plan-write-a',
      runUuid: harnessA.run.uuid,
      name: 'plan-write',
      status: 'passed',
      attempt: 1,
      startedAt: new Date(),
      completedAt: new Date(),
    });
    harnessA.container.phaseRepository.insert({
      id: 'phase-plan-review-a',
      runUuid: harnessA.run.uuid,
      name: 'plan-review',
      status: 'passed',
      attempt: 1,
      startedAt: new Date(),
      completedAt: new Date(),
    });
    harnessA.container.phaseRepository.insert({
      id: 'phase-implement-a',
      runUuid: harnessA.run.uuid,
      name: 'implement',
      status: 'failed',
      attempt: 1,
      startedAt: new Date(),
    });

    harnessA.container.stepRepository.upsert({
      id: `step-${harnessA.run.uuid}-1`,
      runId: harnessA.run.uuid,
      phaseId: 'implement',
      index: 1,
      title: 'Task 1: In-scope repair',
      status: 'failed',
      initialPreStepHead: baselineShaA,
      revertCounts: {},
    });

    await harnessA.context.artifacts.write({
      runId: harnessA.run.uuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: '# Issue\n',
    });
    await harnessA.context.artifacts.write({
      runId: harnessA.run.uuid,
      phaseId: 'read_issue',
      relativePath: 'issue-comments.md',
      contents: '[]\n',
    });
    await harnessA.context.artifacts.write({
      runId: harnessA.run.uuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n',
    });
    await harnessA.context.artifacts.write({
      runId: harnessA.run.uuid,
      phaseId: 'plan-write',
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: In-scope repair\nEdit src/task1.ts\n',
    });
    await harnessA.context.artifacts.write({
      runId: harnessA.run.uuid,
      phaseId: 'plan-write',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Task 1: In-scope repair',
            expected_files: ['src/task1.ts'],
          },
        ],
      }),
    });
    await harnessA.context.artifacts.write({
      runId: harnessA.run.uuid,
      phaseId: 'plan-review',
      relativePath: 'plan-review-findings.md',
      contents: '## verdict\npass\n',
    });
    await harnessA.context.artifacts.write({
      runId: harnessA.run.uuid,
      phaseId: 'plan-review',
      relativePath: 'plan-review-passed.marker',
      contents: '',
    });

    // Explicit preserve_working_tree disposition via API (with confirm: true)
    const apiResA = await harnessA.app.inject({
      method: 'POST',
      url: `/api/runs/${harnessA.run.uuid}/resume`,
      headers: {
        'x-repository-id': String(harnessA.run.repoId),
      },
      payload: { disposition: 'preserve_working_tree', confirm: true },
    });
    expect(apiResA.statusCode).toBe(202);
    expect(apiResA.json().job.resumeDisposition).toBe('preserve_working_tree');

    // Worker executes
    const workerIdA = WorkerId('worker-preserve-1');
    harnessA.container.workerRegistry!.register({
      id: workerIdA,
      repoId: harnessA.run.repoId,
      hostname: os.hostname(),
      processId: process.pid,
      status: 'idle',
      registeredAt: new Date(),
      heartbeatAt: new Date(),
    });

    await workerLoop(workerIdA, {
      ...harnessA.container.workerLoopDeps!(harnessA.run.repoId),
      now: () => new Date(),
      ttlMs: 60_000,
    });

    // Check that Git was NOT reset to baseline (no resume reset event)
    const eventsA = harnessA.container.eventRepository.listByRunSince(
      RunId(harnessA.run.uuid),
      new Date(0),
    );
    expect(eventsA.some((e) => e.type === 'run.resume_worktree_reset')).toBe(false);

    // Operator repair in src/task1.ts survived into the final commit
    const finalRunA = harnessA.container.runRepository.findByUuid(harnessA.run.uuid);
    expect(finalRunA?.status).toBe('passed');

    // -------------------------------------------------------------
    // Part B: Out-of-scope dirty operator repair escalates untouched
    // -------------------------------------------------------------
    const harnessB = trackHarness(await createHarness({ scripts: reviewScripts }));

    execFileSync(
      'git',
      [
        'worktree',
        'add',
        '-b',
        `ai/issue-${harnessB.run.issueNumber}`,
        harnessB.worktreeDir,
        'main',
      ],
      { cwd: harnessB.targetRoot },
    );

    mkdirSync(path.join(harnessB.worktreeDir, 'src'), { recursive: true });
    writeFileSync(path.join(harnessB.worktreeDir, 'src', 'task1.ts'), 'export const task1 = 0;\n');
    writeFileSync(path.join(harnessB.worktreeDir, 'src', 'ref.ts'), 'export const ref = 100;\n');
    execFileSync('git', ['add', '.'], { cwd: harnessB.worktreeDir });
    execFileSync('git', ['commit', '-m', 'baseline commit with ref file'], {
      cwd: harnessB.worktreeDir,
    });
    const baselineShaB = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: harnessB.worktreeDir,
      encoding: 'utf8',
    }).trim();

    // Operator modified an out-of-scope reference file
    writeFileSync(
      path.join(harnessB.worktreeDir, 'src', 'ref.ts'),
      '// operator edited reference file (out of scope for task 1)\n',
    );

    harnessB.container.runRepository.update(harnessB.run.uuid, {
      status: 'needs_human_review',
      currentPhase: 'implement',
      completedPhases: ['read_issue', 'plan-design', 'plan-write', 'plan-review'],
    });

    harnessB.container.phaseRepository.insert({
      id: 'phase-read-issue-b',
      runUuid: harnessB.run.uuid,
      name: 'read_issue',
      status: 'passed',
      attempt: 1,
      startedAt: new Date(),
      completedAt: new Date(),
    });
    harnessB.container.phaseRepository.insert({
      id: 'phase-plan-design-b',
      runUuid: harnessB.run.uuid,
      name: 'plan-design',
      status: 'passed',
      attempt: 1,
      startedAt: new Date(),
      completedAt: new Date(),
    });
    harnessB.container.phaseRepository.insert({
      id: 'phase-plan-write-b',
      runUuid: harnessB.run.uuid,
      name: 'plan-write',
      status: 'passed',
      attempt: 1,
      startedAt: new Date(),
      completedAt: new Date(),
    });
    harnessB.container.phaseRepository.insert({
      id: 'phase-plan-review-b',
      runUuid: harnessB.run.uuid,
      name: 'plan-review',
      status: 'passed',
      attempt: 1,
      startedAt: new Date(),
      completedAt: new Date(),
    });
    harnessB.container.phaseRepository.insert({
      id: 'phase-implement-b',
      runUuid: harnessB.run.uuid,
      name: 'implement',
      status: 'failed',
      attempt: 1,
      startedAt: new Date(),
    });

    harnessB.container.stepRepository.upsert({
      id: `step-${harnessB.run.uuid}-1`,
      runId: harnessB.run.uuid,
      phaseId: 'implement',
      index: 1,
      title: 'Task 1: Out of scope check',
      status: 'failed',
      initialPreStepHead: baselineShaB,
      revertCounts: {},
    });

    await harnessB.context.artifacts.write({
      runId: harnessB.run.uuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: '# Issue\n',
    });
    await harnessB.context.artifacts.write({
      runId: harnessB.run.uuid,
      phaseId: 'read_issue',
      relativePath: 'issue-comments.md',
      contents: '[]\n',
    });
    await harnessB.context.artifacts.write({
      runId: harnessB.run.uuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n',
    });
    await harnessB.context.artifacts.write({
      runId: harnessB.run.uuid,
      phaseId: 'plan-write',
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: Out of scope check\nEdit src/task1.ts\n',
    });
    await harnessB.context.artifacts.write({
      runId: harnessB.run.uuid,
      phaseId: 'plan-write',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Task 1: Out of scope check',
            expected_files: ['src/task1.ts'],
            reference_files: ['src/ref.ts'],
          },
        ],
      }),
    });
    await harnessB.context.artifacts.write({
      runId: harnessB.run.uuid,
      phaseId: 'plan-review',
      relativePath: 'plan-review-findings.md',
      contents: '## verdict\npass\n',
    });
    await harnessB.context.artifacts.write({
      runId: harnessB.run.uuid,
      phaseId: 'plan-review',
      relativePath: 'plan-review-passed.marker',
      contents: '',
    });

    const apiResB = await harnessB.app.inject({
      method: 'POST',
      url: `/api/runs/${harnessB.run.uuid}/resume`,
      headers: {
        'x-repository-id': String(harnessB.run.repoId),
      },
      payload: { disposition: 'preserve_working_tree', confirm: true },
    });
    expect(apiResB.statusCode).toBe(202);

    const workerIdB = WorkerId('worker-preserve-2');
    harnessB.container.workerRegistry!.register({
      id: workerIdB,
      repoId: harnessB.run.repoId,
      hostname: os.hostname(),
      processId: process.pid,
      status: 'idle',
      registeredAt: new Date(),
      heartbeatAt: new Date(),
    });

    await workerLoop(workerIdB, {
      ...harnessB.container.workerLoopDeps!(harnessB.run.repoId),
      now: () => new Date(),
      ttlMs: 60_000,
    });

    // Out of scope repair escalates to needs_human_review untouched
    const finalRunB = harnessB.container.runRepository.findByUuid(harnessB.run.uuid);
    expect(finalRunB?.status).toBe('needs_human_review');

    // Worktree was NOT modified: src/ref.ts still contains the operator's modification
    expect(readFileSync(path.join(harnessB.worktreeDir, 'src', 'ref.ts'), 'utf-8')).toBe(
      '// operator edited reference file (out of scope for task 1)\n',
    );
  }, 30_000);

  it('does not silently clean a detected plan-review contract violation', async () => {
    // -------------------------------------------------------------
    // Part A: Detected plan-review contract violation escalates upstream
    // -------------------------------------------------------------
    const contractViolationReviewScript: ScriptedAgentScript = {
      phaseId: 'plan-review',
      handle: async (_request) => {
        // Agent violates contract: returns contract_violation outcome without writing findings artifact
        return {
          runtime: 'test' as const,
          provider: 'test',
          model: 'test',
          exitCode: 1,
          durationMs: 10,
          stdoutPath: '/dev/null',
          stderrPath: '/dev/null',
          contractViolations: ['missing_required_artifact'],
          outcome: 'contract_violation' as const,
        };
      },
    };

    const harnessA = trackHarness(
      await createHarness({
        scripts: [contractViolationReviewScript],
      }),
    );

    execFileSync(
      'git',
      [
        'worktree',
        'add',
        '-b',
        `ai/issue-${harnessA.run.issueNumber}`,
        harnessA.worktreeDir,
        'main',
      ],
      { cwd: harnessA.targetRoot },
    );

    harnessA.container.runRepository.update(harnessA.run.uuid, {
      status: 'running',
      currentPhase: null,
      completedPhases: ['read_issue', 'plan-design', 'plan-write'],
    });

    await harnessA.context.artifacts.write({
      runId: harnessA.run.uuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: '# Issue\n',
    });
    await harnessA.context.artifacts.write({
      runId: harnessA.run.uuid,
      phaseId: 'read_issue',
      relativePath: 'issue-comments.md',
      contents: '[]\n',
    });
    await harnessA.context.artifacts.write({
      runId: harnessA.run.uuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n',
    });
    await harnessA.context.artifacts.write({
      runId: harnessA.run.uuid,
      phaseId: 'plan-write',
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: Task\n',
    });
    await harnessA.context.artifacts.write({
      runId: harnessA.run.uuid,
      phaseId: 'plan-write',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [{ n: 1, title: 'Task 1' }],
      }),
    });

    // Write a probe file in worktree
    writeFileSync(path.join(harnessA.worktreeDir, 'violating-agent-residue.tmp'), 'probe residue');

    const runToExecA = harnessA.container.runRepository.findByUuid(harnessA.run.uuid)!;
    const execResultA = await harnessA.container.runExecutor!.execute({
      run: runToExecA,
      skip: [],
      presentArtifacts: [],
    });

    // Plan review failed due to contract violation and halted execution
    expect(execResultA.run.status).toBe('failed');

    // Implement was never entered
    const implementPhaseA = execResultA.phases.find((p) => p.phase === 'implement');
    expect(implementPhaseA).toBeUndefined();

    // Event repository has NO implement.inbound_worktree_reset event
    const eventsA = harnessA.container.eventRepository.listByRunSince(
      RunId(harnessA.run.uuid),
      new Date(0),
    );
    expect(eventsA.some((e) => e.type === 'implement.inbound_worktree_reset')).toBe(false);

    // -------------------------------------------------------------
    // Part B: Residual ambient drift from passed plan-review is audited and cleaned at implement boundary
    // -------------------------------------------------------------
    const passingReviewWithDriftScript: ScriptedAgentScript = {
      phaseId: 'plan-review',
      handle: async (request) => {
        writeFileSync(
          path.join(request.cwd, 'plan-review-findings.md'),
          '## verdict\npass\n\n## findings\n',
        );
        // Review probe leaves ambient residue in the persistent worktree
        writeFileSync(
          path.join(request.cwd, 'ambient-review-probe.tmp'),
          'temporary probe residue\n',
        );
        return {
          runtime: 'test' as const,
          provider: 'test',
          model: 'test',
          exitCode: 0,
          durationMs: 10,
          stdoutPath: '/dev/null',
          stderrPath: '/dev/null',
          contractViolations: [],
          outcome: 'success' as const,
        };
      },
    };

    const implementScript: ScriptedAgentScript = {
      phaseId: 'implement',
      handle: async (request) => {
        mkdirSync(path.join(request.cwd, 'src'), { recursive: true });
        writeFileSync(path.join(request.cwd, 'src', 'task1.ts'), 'export const task1 = 1;\n');
        execFileSync('git', ['add', '.'], { cwd: request.cwd });
        execFileSync('git', ['commit', '-m', 'implement: task 1'], { cwd: request.cwd });
        return {
          runtime: 'test' as const,
          provider: 'test',
          model: 'test',
          exitCode: 0,
          durationMs: 10,
          stdoutPath: '/dev/null',
          stderrPath: '/dev/null',
          contractViolations: [],
          outcome: 'success' as const,
        };
      },
    };

    const reviewPassingScripts: ScriptedAgentScript[] = [
      {
        phaseId: 'spec-review',
        handle: async (request) => {
          writeFileSync(
            path.join(request.cwd, 'result.json'),
            JSON.stringify({ result: 'pass', reviewType: 'spec', findings: [] }),
          );
          return {
            runtime: 'test' as const,
            provider: 'test',
            model: 'test',
            exitCode: 0,
            durationMs: 10,
            stdoutPath: '/dev/null',
            stderrPath: '/dev/null',
            contractViolations: [],
            outcome: 'success' as const,
          };
        },
      },
      {
        phaseId: 'quality-review',
        handle: async (request) => {
          writeFileSync(
            path.join(request.cwd, 'result.json'),
            JSON.stringify({ result: 'pass', reviewType: 'quality', findings: [] }),
          );
          return {
            runtime: 'test' as const,
            provider: 'test',
            model: 'test',
            exitCode: 0,
            durationMs: 10,
            stdoutPath: '/dev/null',
            stderrPath: '/dev/null',
            contractViolations: [],
            outcome: 'success' as const,
          };
        },
      },
    ];

    const harnessB = trackHarness(
      await createHarness({
        scripts: [passingReviewWithDriftScript, implementScript, ...reviewPassingScripts],
      }),
    );

    execFileSync(
      'git',
      [
        'worktree',
        'add',
        '-b',
        `ai/issue-${harnessB.run.issueNumber}`,
        harnessB.worktreeDir,
        'main',
      ],
      { cwd: harnessB.targetRoot },
    );

    harnessB.container.runRepository.update(harnessB.run.uuid, {
      status: 'running',
      currentPhase: null,
      completedPhases: ['read_issue', 'plan-design', 'plan-write'],
    });

    await harnessB.context.artifacts.write({
      runId: harnessB.run.uuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: '# Issue\n',
    });
    await harnessB.context.artifacts.write({
      runId: harnessB.run.uuid,
      phaseId: 'read_issue',
      relativePath: 'issue-comments.md',
      contents: '[]\n',
    });
    await harnessB.context.artifacts.write({
      runId: harnessB.run.uuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n',
    });
    await harnessB.context.artifacts.write({
      runId: harnessB.run.uuid,
      phaseId: 'plan-write',
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: First Task\nImplement task 1 in src/task1.ts\n',
    });
    await harnessB.context.artifacts.write({
      runId: harnessB.run.uuid,
      phaseId: 'plan-write',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [{ n: 1, title: 'First Task' }],
      }),
    });

    const runToExecB = harnessB.container.runRepository.findByUuid(harnessB.run.uuid)!;
    const execResultB = await harnessB.container.runExecutor!.execute({
      run: runToExecB,
      skip: [],
      presentArtifacts: [],
    });

    // Run completed cleanly through implement
    expect(execResultB.run.status).toBe('passed');

    // Ambient review probe was audited and discarded at the implement boundary
    const eventsB = harnessB.container.eventRepository.listByRunSince(
      RunId(harnessB.run.uuid),
      new Date(0),
    );
    const inboundResetEvent = eventsB.find((e) => e.type === 'implement.inbound_worktree_reset');
    expect(inboundResetEvent).toBeDefined();
    expect(inboundResetEvent!.metadata?.priorPhaseName).toBe('plan-review');
    expect(inboundResetEvent!.metadata?.discardedPaths).toContain('ambient-review-probe.tmp');

    // Untracked residue is gone from worktree
    expect(existsSync(path.join(harnessB.worktreeDir, 'ambient-review-probe.tmp'))).toBe(false);
  }, 30_000);
});

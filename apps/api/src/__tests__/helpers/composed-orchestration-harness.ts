import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { composeRoot, type Container } from '../../compose.js';
import type {
  AgentPort,
  AgentInvocationRequest,
  AgentInvocationResult,
  PhaseHandlerContext,
} from '@ai-sdlc/application';
import { RepositoryId, type Run } from '@ai-sdlc/domain';
import { randomUUID, createHash } from 'node:crypto';

export function createReviewFailScript(): ScriptedAgentScript {
  return {
    phaseId: 'whole-pr-review',
    invocationType: 'initial',
    handle: async (request) => {
      const resultJson = JSON.stringify({
        result: 'fail',
        findings: [{ severity: 'warning', summary: 'Test finding' }],
      });
      writeFileSync(path.join(request.cwd, 'result.json'), resultJson, 'utf-8');
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
}

export function createReviewPassScript(invocationType = 'semantic_retry'): ScriptedAgentScript {
  return {
    phaseId: 'whole-pr-review',
    invocationType,
    handle: async (request) => {
      const resultJson = JSON.stringify({ result: 'pass', findings: [] });
      writeFileSync(path.join(request.cwd, 'result.json'), resultJson, 'utf-8');
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
}

export function createFixCommitsResultScript(): ScriptedAgentScript {
  return {
    phaseId: 'fix-review',
    invocationType: 'initial',
    handle: async (request) => {
      const resultJson = JSON.stringify({ result: 'done_with_fixes' });
      writeFileSync(path.join(request.cwd, 'result.json'), resultJson, 'utf-8');
      execFileSync('git', ['add', 'result.json'], { cwd: request.cwd });
      execFileSync('git', ['commit', '-m', 'fix: test fix'], { cwd: request.cwd });
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
}

export function createImplementPassScript(): ScriptedAgentScript {
  return {
    phaseId: 'implement',
    invocationType: 'initial',
    handle: async (request) => {
      const implLog = JSON.stringify({ files: [], summary: 'test implementation' });
      writeFileSync(path.join(request.cwd, 'implementation-log.md'), implLog, 'utf-8');
      execFileSync('git', ['add', 'implementation-log.md'], { cwd: request.cwd });
      execFileSync('git', ['commit', '-m', 'implement: test'], { cwd: request.cwd });
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
}

export function createSpecReviewPassScript(): ScriptedAgentScript {
  return {
    phaseId: 'spec-review',
    invocationType: 'initial',
    handle: async (request) => {
      const resultJson = JSON.stringify({ result: 'pass' });
      writeFileSync(path.join(request.cwd, 'result.json'), resultJson, 'utf-8');
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
}

export function createQualityReviewPassScript(): ScriptedAgentScript {
  return {
    phaseId: 'quality-review',
    invocationType: 'initial',
    handle: async (request) => {
      const resultJson = JSON.stringify({ result: 'pass' });
      writeFileSync(path.join(request.cwd, 'result.json'), resultJson, 'utf-8');
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
}

export function createPlanReviewSemanticScript(findingsMd: string): ScriptedAgentScript {
  return {
    phaseId: 'plan-review',
    invocationType: 'initial',
    handle: async (request) => {
      const findingsPath = path.join(request.cwd, 'plan-review-findings.md');
      writeFileSync(findingsPath, findingsMd, 'utf-8');
      return {
        runtime: 'test' as const,
        provider: 'test',
        model: 'test',
        exitCode: 0,
        durationMs: 10,
        stdout: findingsMd,
        stderrPath: '/dev/null',
        contractViolations: [],
        outcome: 'success' as const,
      };
    },
  };
}

export function createPlanReviewOrdinaryFixScript(
  planModifier: (currentPlan: string) => string,
  resultJson: string,
): ScriptedAgentScript {
  return {
    phaseId: 'plan-fix',
    invocationType: 'initial',
    handle: async (request) => {
      const planPath = path.join(request.cwd, 'plan.md');
      let currentPlan = '';
      try {
        currentPlan = readFileSync(planPath, 'utf-8');
      } catch {}
      const updatedPlan = planModifier(currentPlan);
      writeFileSync(planPath, updatedPlan, 'utf-8');

      const resultPath = path.join(request.cwd, 'plan-fix-result.json');
      writeFileSync(resultPath, resultJson, 'utf-8');

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
}

export function createPlanReviewTerminalFixScript(
  planModifier: (currentPlan: string) => string,
  manifestModifier: (currentManifest: string) => string,
  resultJson: string,
): ScriptedAgentScript {
  return {
    phaseId: 'plan-fix',
    invocationType: 'terminal_fix',
    handle: async (request) => {
      const planPath = path.join(request.cwd, 'plan.md');
      let currentPlan = '';
      try {
        currentPlan = readFileSync(planPath, 'utf-8');
      } catch {}
      const updatedPlan = planModifier(currentPlan);
      writeFileSync(planPath, updatedPlan, 'utf-8');

      const manifestPath = path.join(request.cwd, 'task-manifest.json');
      let currentManifest = '';
      try {
        currentManifest = readFileSync(manifestPath, 'utf-8');
      } catch {}
      const updatedManifest = manifestModifier(currentManifest);
      writeFileSync(manifestPath, updatedManifest, 'utf-8');

      const resultPath = path.join(request.cwd, 'plan-fix-result.json');
      writeFileSync(resultPath, resultJson, 'utf-8');

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
}

export interface ScriptedAgentScript {
  phaseId?: string;
  invocationType?: string;
  handle: (
    request: AgentInvocationRequest,
  ) => AgentInvocationResult | Promise<AgentInvocationResult>;
}

export interface ComposedOrchestrationHarnessOptions {
  repoFullName: string;
  issueNumber?: number;
  validationCommands?: string[];
  scripts?: ScriptedAgentScript[];
  ambientGitHubRepository?: string;
  agentConfig?: object;
}

export interface ComposedOrchestrationHarness {
  container: Container;
  run: Run;
  context: PhaseHandlerContext;
  targetRoot: string;
  automationRoot: string;
  scriptedInvocations: AgentInvocationRequest[];
  cleanup: () => void;
}

function makeMinimalAgentConfig(validationCommands: string[]): object {
  return {
    validation: { commands: validationCommands, timeout: 60 },
    phases: {
      skip: [],
      reviewFix: { maxIterations: 1 },
      implement: { maxIterations: 1 },
      fixValidate: { enabled: false, maxIterations: 3 },
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
        implement: { profile: 'test' },
        'spec-review': { profile: 'test' },
        'quality-review': { profile: 'test' },
      },
    },
  };
}

function initGitRepo(repoPath: string, identity: { name: string; email: string }): void {
  execFileSync('git', ['init'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', identity.name], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', identity.email], { cwd: repoPath });
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: repoPath });
  writeFileSync(path.join(repoPath, 'README.md'), '# Baseline\n');
  // ReviewFixLoop's post-fix gate shells out to `pnpm -r build/typecheck` and
  // `pnpm lint` in the worktree (apps/api/src/compose.ts runPostFixGate).
  // Without a package.json exposing no-op scripts, `pnpm lint` fails with
  // ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND, which trips the gate and routes
  // the loop into a `fix-review:deterministic_fix` agent invocation the
  // harness has no script for.
  writeFileSync(
    path.join(repoPath, 'package.json'),
    JSON.stringify({
      name: 'harness-target',
      private: true,
      scripts: { build: 'exit 0', typecheck: 'exit 0', lint: 'exit 0' },
    }),
  );
  execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: repoPath });
}

class ScriptedAgentPort implements AgentPort {
  readonly invocations: AgentInvocationRequest[] = [];
  private readonly scripts: Map<string, ScriptedAgentScript['handle']>;

  constructor(scripts: ScriptedAgentScript[] = []) {
    this.scripts = new Map();
    for (const script of scripts) {
      const key = `${script.phaseId ?? ''}:${String(script.invocationType ?? 'initial')}`;
      this.scripts.set(key, script.handle);
    }
  }

  async invoke(input: AgentInvocationRequest): Promise<AgentInvocationResult> {
    this.invocations.push(input);
    const key = `${input.phaseId}:${String(input.metadata?.invocation_type ?? 'initial')}`;
    const handler = this.scripts.get(key);
    if (!handler) {
      const available = Array.from(this.scripts.keys()).join(', ');
      throw new Error(
        `No scripted agent handler for key "${key}". Available: ${available}. ` +
          `Phase: ${input.phaseId}, invocation_type: ${String(input.metadata?.invocation_type ?? 'initial')}, ` +
          `metadata: ${JSON.stringify(input.metadata)}`,
      );
    }
    return handler(input);
  }
}

export function createComposedOrchestrationHarness(
  opts: ComposedOrchestrationHarnessOptions,
): ComposedOrchestrationHarness {
  const automationRoot = mkdtempSync(path.join(os.tmpdir(), 'ai-orch-harness-'));
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

  const planReviewPromptsRoot = path.join(targetRoot, 'prompts', 'plan-review');
  mkdirSync(planReviewPromptsRoot, { recursive: true });

  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const repoPromptsDir = path.join(selfDir, '..', '..', '..', '..', '..', 'prompts');
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

  const config = opts.agentConfig ?? makeMinimalAgentConfig(opts.validationCommands ?? ['echo ok']);
  writeFileSync(path.join(targetRoot, '.ai-orchestrator.json'), JSON.stringify(config));

  const scriptPath = path.join(automationRoot, 'fake.sh');
  writeFileSync(scriptPath, '#!/usr/bin/env bash\necho ok\nexit 0\n');
  chmodSync(scriptPath, 0o755);

  const scriptedAgent = new ScriptedAgentPort(opts.scripts ?? []);

  const container = composeRoot({
    repoRoot: targetRoot,
    scriptPath,
    dbPath,
    runsDir,
    baseTmpDir,
    repoFullName: opts.repoFullName,
    agentAdapterOverrides: {
      opencode: scriptedAgent,
    },
  });

  const [owner, repoName] = opts.repoFullName.split('/');
  const repoId = RepositoryId(
    createHash('sha256').update(opts.repoFullName).digest('hex').slice(0, 16),
  );

  container.repositoryRegistry.insert({
    id: repoId,
    fullName: opts.repoFullName,
    owner: owner ?? 'owner',
    name: repoName ?? 'repo',
    localBasePath: targetRoot,
    defaultBranch: 'main',
    remoteUrl: `git@github.com:${opts.repoFullName}.git`,
    enabled: true,
    maxConcurrentRuns: 1,
    healthStatus: 'healthy' as const,
    healthError: null,
    lastHealthCheckAt: new Date(),
    configMetadata: '{}',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const issueNumber = opts.issueNumber ?? 1;
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
    skippedPhases: [],
    startedAt: new Date(),
  };

  container.runRepository.insertIfNoActive(runRecord);

  const context = container.buildRunContext!(runRecord);

  const worktreeIssueDir = path.join(worktreeRoot, `issue-${runRecord.issueNumber}`);
  mkdirSync(worktreeIssueDir, { recursive: true });

  const cleanup = () => {
    try {
      rmSync(automationRoot, { recursive: true, force: true });
    } catch {}
  };

  return {
    container,
    run: runRecord,
    context,
    targetRoot,
    automationRoot,
    scriptedInvocations: scriptedAgent.invocations,
    cleanup,
  };
}

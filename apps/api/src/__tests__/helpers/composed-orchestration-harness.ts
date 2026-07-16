import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composeRoot, type Container } from '../../compose.js';
import type {
  AgentPort,
  AgentInvocationRequest,
  AgentInvocationResult,
  ValidationPort,
  RunValidationInput,
  ValidationCommandResult,
  PhaseHandlerContext,
} from '@ai-sdlc/application';
import { RepositoryId, type Run } from '@ai-sdlc/domain';
import { randomUUID, createHash } from 'node:crypto';

export interface ScriptedAgentScript {
  phaseId?: string;
  invocationType?: string;
  handle: (
    request: AgentInvocationRequest,
  ) => AgentInvocationResult | Promise<AgentInvocationResult>;
}

export interface RecordingValidationPort extends ValidationPort {
  readonly inputs: RunValidationInput[];
  readonly results: ValidationCommandResult[][];
}

export interface ComposedOrchestrationHarnessOptions {
  repoFullName: string;
  issueNumber?: number;
  validationCommands?: string[];
  scripts?: ScriptedAgentScript[];
  ambientGitHubRepository?: string;
}

export interface ComposedOrchestrationHarness {
  container: Container;
  run: Run;
  context: PhaseHandlerContext;
  targetRoot: string;
  automationRoot: string;
  scriptedInvocations: AgentInvocationRequest[];
  validationPort: RecordingValidationPort;
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
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
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

class RecordingValidationAdapter implements RecordingValidationPort {
  readonly inputs: RunValidationInput[] = [];
  readonly results: ValidationCommandResult[][] = [];

  async run(input: RunValidationInput): Promise<ValidationCommandResult[]> {
    this.inputs.push({ ...input });
    const result: ValidationCommandResult[] = (input.commands || ['echo ok']).map((cmd) => {
      const isFailure = cmd.trim() === 'exit 1';
      return {
        command: cmd,
        exitCode: isFailure ? 1 : 0,
        durationMs: 1,
        stdout: '',
        stderr: isFailure ? 'exit 1' : '',
        stdoutPath: '',
        stderrPath: '',
        outcome: isFailure ? ('failed' as const) : ('passed' as const),
      };
    });
    this.results.push(result);
    return result;
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

  const config = makeMinimalAgentConfig(opts.validationCommands ?? ['echo ok']);
  writeFileSync(path.join(targetRoot, '.ai-orchestrator.json'), JSON.stringify(config));

  const scriptPath = path.join(automationRoot, 'fake.sh');
  writeFileSync(scriptPath, '#!/usr/bin/env bash\necho ok\nexit 0\n');
  chmodSync(scriptPath, 0o755);

  const scriptedAgent = new ScriptedAgentPort(opts.scripts ?? []);
  const recordingValidation = new RecordingValidationAdapter();

  const container = composeRoot({
    repoRoot: targetRoot,
    scriptPath,
    dbPath,
    runsDir,
    baseTmpDir,
    agentAdapterOverrides: {
      opencode: scriptedAgent,
    },
    validationPort: recordingValidation,
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
    validationPort: recordingValidation,
    cleanup,
  };
}

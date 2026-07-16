import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeRoot, type ComposeOptions } from '../compose.js';
import type { AgentPort } from '@ai-sdlc/application';
import type { AgentRuntimeKind } from '@ai-sdlc/domain';
import type { ValidationPort, RunValidationInput } from '@ai-sdlc/application';
import type { AgentInvocationRequest } from '@ai-sdlc/application';
import { RepositoryId, type PhaseName } from '@ai-sdlc/domain';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(
      (
        file: Parameters<typeof actual.execFileSync>[0],
        args: Parameters<typeof actual.execFileSync>[1],
        options: Parameters<typeof actual.execFileSync>[2],
      ) => actual.execFileSync(file, args, options),
    ),
  };
});

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

function makeRepoRoot(): string {
  const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-injection-')));
  return root;
}

function fakeScript(exitCode: number): string {
  const dir = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-injection-script-')));
  const scriptPath = path.join(dir, 'run.sh');
  writeFileSync(scriptPath, `#!/usr/bin/env bash\nexit ${exitCode}\n`);
  chmodSync(scriptPath, 0o755);
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
      },
    },
  };
}

class RecordingValidationAdapter implements ValidationPort {
  readonly inputs: RunValidationInput[] = [];

  async run(
    input: RunValidationInput,
  ): Promise<import('@ai-sdlc/application').ValidationCommandResult[]> {
    this.inputs.push(input);
    return [
      {
        command: input.commands[0] ?? 'echo 1',
        exitCode: 0,
        durationMs: 1,
        stdout: '',
        stderr: '',
        stdoutPath: '',
        stderrPath: '',
        outcome: 'passed',
      },
    ];
  }
}

class ScriptedAgentPort implements AgentPort {
  readonly invocations: AgentInvocationRequest[] = [];

  async invoke(
    input: AgentInvocationRequest,
  ): Promise<import('@ai-sdlc/application').AgentInvocationResult> {
    this.invocations.push(input);
    return {
      success: true,
      transcript: [],
    };
  }
}

const FAKE_METADATA_RESOLVER: ComposeOptions['metadataResolver'] = {
  resolve: (p) => ({
    rootPath: p,
    nameWithOwner: 'owner/repo',
    defaultBranch: 'main',
    remoteUrl: 'https://github.com/owner/repo.git',
  }),
};

describe('composeRoot — injection seams', () => {
  it('production composition defaults remain active when no overrides are supplied', () => {
    const root = makeRepoRoot();
    const scriptPath = fakeScript(0);
    writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(makeAgentConfig()));

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
    });

    expect(container.runValidation).toBeDefined();
    expect(typeof container.runValidation.execute).toBe('function');
    expect(container.agentRuntime).toBeDefined();
  });

  it('validation override is used by composed validation call sites', async () => {
    const root = makeRepoRoot();
    const scriptPath = fakeScript(0);
    writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(makeAgentConfig()));
    const recordingValidation = new RecordingValidationAdapter();

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
      validationPort: recordingValidation,
    });

    expect(container.runValidation).toBeDefined();

    const runOut = await container.startIssueRun.execute({
      issueNumber: 1,
      repoId: RepositoryId('owner/repo'),
    });
    expect(runOut.status).toBe('passed');

    const validationInput = {
      runId: runOut.uuid,
      phaseId: 'implement' as PhaseName,
      cwd: root,
      logDir: root,
      commands: ['echo test'],
      timeoutSeconds: 10,
    };
    await container.runValidation.execute(validationInput);
    expect(recordingValidation.inputs).toEqual([
      expect.objectContaining({
        cwd: root,
        commands: ['echo test'],
        timeoutSeconds: 10,
        logDir: root,
      }),
    ]);
  });

  it('runtime overrides replace only their matching runtime adapter', () => {
    const root = makeRepoRoot();
    const scriptPath = fakeScript(0);
    writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(makeAgentConfig()));
    const scriptedAgent = new ScriptedAgentPort();

    const agentAdapterOverrides: Partial<Record<AgentRuntimeKind, AgentPort>> = {
      opencode: scriptedAgent,
    };

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
      agentAdapterOverrides,
    });

    expect(container.agentRuntime).toBeDefined();
  });
});

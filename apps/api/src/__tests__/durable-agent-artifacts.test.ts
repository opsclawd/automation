import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentProfileName,
  type AgentInvocationRequest,
  type AgentInvocationResult,
  type AgentPort,
  type Artifact,
  type ArtifactStore,
  type WriteArtifactInput,
} from '@ai-sdlc/application';
import { createArtifactCapturingAgent } from '../durable-agent-artifacts.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function trackDir<T>(fn: () => T): T {
  const result = fn();
  tempDirs.push(result as unknown as string);
  return result;
}

function makeWorktree() {
  const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-durable-artifacts-')));
  return root;
}

function writeTextFile(root: string, relativePath: string, contents: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, 'utf-8');
}

function makeResult(): AgentInvocationResult {
  return {
    runtime: 'opencode',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    exitCode: 0,
    durationMs: 42,
    stdoutPath: '/tmp/stdout',
    stderrPath: '/tmp/stderr',
    contractViolations: [],
    outcome: 'success',
  };
}

function makeRequest(cwd: string, phaseId = 'implement'): AgentInvocationRequest {
  return {
    profile: AgentProfileName('opencode-frontier'),
    promptPath: '/tmp/prompt.md',
    expectedArtifacts: ['result.json', 'implementation-log.md', 'result.json'],
    cwd,
    runId: 'run-123',
    repoId: 'owner/repo',
    phaseId,
    startCommitSha: '0'.repeat(40),
  };
}

function makeStore(writes: Array<WriteArtifactInput>): ArtifactStore {
  return {
    async write(input: WriteArtifactInput): Promise<Artifact> {
      writes.push(input);
      return {
        runId: input.runId,
        ...(input.phaseId ? { phaseId: input.phaseId } : {}),
        relativePath: input.relativePath,
        absolutePath: `mem://${input.runId}/${input.relativePath}`,
        bytes: Buffer.byteLength(input.contents),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      };
    },
    async read(): Promise<string> {
      throw new Error('not used');
    },
    async list(): Promise<Artifact[]> {
      return [];
    },
  };
}

describe('createArtifactCapturingAgent', () => {
  it('captures expected, phase, and optional artifacts after the wrapped agent resolves', async () => {
    const cwd = makeWorktree();
    writeTextFile(cwd, 'result.json', '{"ok":true}');
    writeTextFile(cwd, 'implementation-log.md', '# implementation');
    writeTextFile(cwd, 'task-manifest.json', '{"tasks":[] }');
    writeTextFile(cwd, 'validation.result', 'passed');
    writeTextFile(cwd, 'validate.log', 'validate log');
    writeTextFile(cwd, 'validate/validation-result.json', '{"result":"ok"}');
    writeTextFile(cwd, 'code-review.md', '# review');
    writeTextFile(cwd, 'review.md', '# review note');
    writeTextFile(cwd, 'compound.md', '# compound');
    writeTextFile(cwd, 'pr-summary.md', '# pr summary');
    writeTextFile(cwd, 'pr-url.txt', 'https://example.test/pr/1');

    const writes: WriteArtifactInput[] = [];
    let agentCompleted = false;
    const expectedResult = makeResult();
    const agent: AgentPort = {
      async invoke(): Promise<AgentInvocationResult> {
        agentCompleted = true;
        return expectedResult;
      },
    };

    const wrapped = createArtifactCapturingAgent({
      agent,
      artifactStoreForRequest: () => makeStore(writes),
      phaseOutputs: { implement: ['implementation-log.md'] },
      optionalArtifacts: [
        'task-manifest.json',
        'validation.result',
        'validate.log',
        'validate/validation-result.json',
        'code-review.md',
        'review.md',
        'result.json',
        'compound.md',
        'pr-summary.md',
        'pr-url.txt',
      ],
    });

    const request = makeRequest(cwd);
    const result = await wrapped.invoke(request);

    expect(result).toBe(expectedResult);
    expect(agentCompleted).toBe(true);
    const sortedWrites = [...writes].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    expect(sortedWrites.map((entry) => entry.relativePath)).toEqual([
      'code-review.md',
      'compound.md',
      'implementation-log.md',
      'pr-summary.md',
      'pr-url.txt',
      'result.json',
      'review.md',
      'task-manifest.json',
      'validate.log',
      'validate/validation-result.json',
      'validation.result',
    ]);
    expect(sortedWrites.map((entry) => entry.contents)).toEqual([
      '# review',
      '# compound',
      '# implementation',
      '# pr summary',
      'https://example.test/pr/1',
      '{"ok":true}',
      '# review note',
      '{"tasks":[] }',
      'validate log',
      '{"result":"ok"}',
      'passed',
    ]);
    expect(writes.every((entry) => entry.runId === request.runId)).toBe(true);
    expect(writes.every((entry) => entry.phaseId === request.phaseId)).toBe(true);
  });

  it('ignores missing optional files without failing the invocation', async () => {
    const cwd = makeWorktree();
    writeTextFile(cwd, 'implementation-log.md', '# implementation');

    const writes: WriteArtifactInput[] = [];
    const wrapped = createArtifactCapturingAgent({
      agent: {
        async invoke(): Promise<AgentInvocationResult> {
          return makeResult();
        },
      },
      artifactStoreForRequest: () => makeStore(writes),
      phaseOutputs: { implement: ['implementation-log.md'] },
      optionalArtifacts: ['pr-url.txt'],
    });

    const result = await wrapped.invoke(makeRequest(cwd));

    expect(result).toBeDefined();
    expect(writes.map((entry) => entry.relativePath)).toEqual(['implementation-log.md']);
  });

  it('propagates agent exceptions without attempting capture', async () => {
    const cwd = makeWorktree();
    writeTextFile(cwd, 'implementation-log.md', '# implementation');

    const writes: WriteArtifactInput[] = [];
    let storeFactoryCalls = 0;
    const wrapped = createArtifactCapturingAgent({
      agent: {
        async invoke(): Promise<AgentInvocationResult> {
          throw new Error('agent failed');
        },
      },
      artifactStoreForRequest: () => {
        storeFactoryCalls++;
        return makeStore(writes);
      },
      phaseOutputs: { implement: ['implementation-log.md'] },
      optionalArtifacts: ['pr-url.txt'],
    });

    await expect(wrapped.invoke(makeRequest(cwd))).rejects.toThrow('agent failed');
    expect(writes).toEqual([]);
    expect(storeFactoryCalls).toBe(0);
  });

  it('throws an error and rejects capturing binary files', async () => {
    const cwd = makeWorktree();
    // Write a file containing a null byte
    const binaryData = Buffer.from('hello\0world', 'utf-8');
    writeFileSync(path.join(cwd, 'binary-artifact.bin'), binaryData);

    const writes: WriteArtifactInput[] = [];
    const wrapped = createArtifactCapturingAgent({
      agent: {
        async invoke(): Promise<AgentInvocationResult> {
          return makeResult();
        },
      },
      artifactStoreForRequest: () => makeStore(writes),
      phaseOutputs: { implement: ['binary-artifact.bin'] },
    });

    await expect(wrapped.invoke(makeRequest(cwd))).rejects.toThrow(
      /binary files are not supported/,
    );
    expect(writes).toEqual([]);
  });
});

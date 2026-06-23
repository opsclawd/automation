import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createVerifyCodeChange } from '../verify-code-change.js';
import type { AgentPort } from '../../ports/agent-port.js';
import type { AgentInvocationResult } from '../../ports/agent-invocation-types.js';
import { AgentProfileName } from '@ai-sdlc/domain';

function makeAgentResult(overrides: Partial<AgentInvocationResult> = {}): AgentInvocationResult {
  return {
    runtime: 'opencode',
    provider: 'test',
    model: 'test',
    exitCode: 0,
    durationMs: 100,
    stdoutPath: '/dev/null',
    stderrPath: '/dev/null',
    contractViolations: [],
    outcome: 'success',
    ...overrides,
  };
}

function makeDeps(resultJson: object | null, outcome: 'success' | 'failed' = 'success') {
  const baseTmpDir = join(tmpdir(), `verify-test-${randomUUID()}`);
  mkdirSync(baseTmpDir, { recursive: true });

  const agent: AgentPort = {
    invoke: vi.fn(async (input) => {
      if (resultJson !== null) {
        writeFileSync(join(input.cwd, 'result.json'), JSON.stringify(resultJson), 'utf-8');
      }
      return makeAgentResult({ outcome });
    }),
  };

  const fn = createVerifyCodeChange({
    agent,
    baseTmpDir,
    resolveProfileForPhase: () => AgentProfileName('test-profile'),
    idFactory: () => 'test-id',
  });

  return { fn, agent, baseTmpDir };
}

describe('createVerifyCodeChange', () => {
  it('returns pass:true when verifier writes pass:true result', async () => {
    const { fn } = makeDeps({ pass: true, reason: 'concern addressed' });
    const result = await fn({
      commentBody: 'Use a const here',
      path: 'src/foo.ts',
      line: 10,
      cwd: '/nonexistent',
      startCommitSha: 'startSha',
      fixCommitSha: 'fixSha',
      runId: 'run-1',
      repoId: 'o/r',
    });
    expect(result.pass).toBe(true);
    expect(result.reason).toBe('concern addressed');
  });

  it('returns pass:false when verifier writes pass:false result', async () => {
    const { fn } = makeDeps({ pass: false, reason: 'still uses let' });
    const result = await fn({
      commentBody: 'Use a const here',
      path: 'src/foo.ts',
      line: 10,
      cwd: '/nonexistent',
      startCommitSha: 'startSha',
      fixCommitSha: 'fixSha',
      runId: 'run-1',
      repoId: 'o/r',
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('still uses let');
  });

  it('returns pass:false when agent invocation does not succeed', async () => {
    const { fn } = makeDeps(null, 'failed');
    const result = await fn({
      commentBody: 'fix it',
      path: 'src/foo.ts',
      line: 5,
      cwd: '/nonexistent',
      startCommitSha: 'a',
      fixCommitSha: 'b',
      runId: 'run-1',
      repoId: 'o/r',
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/did not succeed/);
  });

  it('returns pass:false when result.json has unexpected shape', async () => {
    const { fn } = makeDeps({ verdict: 'yes' });
    const result = await fn({
      commentBody: 'fix it',
      path: 'src/foo.ts',
      line: 5,
      cwd: '/nonexistent',
      startCommitSha: 'a',
      fixCommitSha: 'b',
      runId: 'run-1',
      repoId: 'o/r',
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/invalid/);
  });

  it('returns pass:true (skip) when resolveProfileForPhase throws', async () => {
    const baseTmpDir = join(tmpdir(), `verify-test-${randomUUID()}`);
    mkdirSync(baseTmpDir, { recursive: true });
    const fn = createVerifyCodeChange({
      agent: { invoke: vi.fn() },
      baseTmpDir,
      resolveProfileForPhase: () => {
        throw new Error('phase not configured');
      },
      idFactory: () => 'id',
    });
    const result = await fn({
      commentBody: 'fix it',
      path: 'src/foo.ts',
      line: 1,
      cwd: '/nonexistent',
      startCommitSha: 'a',
      fixCommitSha: 'b',
      runId: 'run-1',
      repoId: 'o/r',
    });
    expect(result.pass).toBe(true);
    expect(result.reason).toMatch(/not configured/);
  });

  it('includes prompt with commentBody and path', async () => {
    const { fn, agent } = makeDeps({ pass: true, reason: 'ok' });
    await fn({
      commentBody: 'Remove this unused import',
      path: 'src/bar.ts',
      line: 3,
      cwd: '/nonexistent',
      startCommitSha: 'a',
      fixCommitSha: 'b',
      runId: 'run-1',
      repoId: 'o/r',
    });
    const invokeArg = (agent.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const { readFileSync } = await import('node:fs');
    const prompt = readFileSync(invokeArg.promptPath, 'utf-8');
    expect(prompt).toContain('Remove this unused import');
    expect(prompt).toContain('src/bar.ts');
  });
});

import { describe, it, expect } from 'vitest';
import { AgentInvocationId, AgentProfileName, PhaseName, RunId } from '@ai-sdlc/domain';
import type { AgentInvocation } from '@ai-sdlc/domain';
import { FakeArtifactStore, FakeAgentPort } from '../test-doubles/index.js';
import { extractResult } from '../results/extract-result.js';

function makeInvocation(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    id: AgentInvocationId('inv-1'),
    runId: RunId('r1'),
    phaseId: PhaseName('plan-design'),
    profile: AgentProfileName('p'),
    runtime: 'opencode',
    provider: 'a',
    model: 'm',
    promptPath: '/p',
    promptChars: 1,
    stdoutPath: '/s',
    stderrPath: '/e',
    startedAt: new Date(),
    startCommitSha: 'a'.repeat(40),
    timeoutMs: 1000,
    resultJsonPath: 'result.json',
    ...overrides,
  };
}

describe('extractResult', () => {
  it('returns typed result on valid input', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'r1',
      relativePath: 'result.json',
      contents: JSON.stringify({ result: 'ready', summary: 'go' }),
    });
    const agent = new FakeAgentPort();
    const outcome = await extractResult({
      invocation: makeInvocation(),
      ports: { artifacts, agent },
      rerunContext: { cwd: '/repo', repoId: 'org/repo' },
    });
    expect(outcome).toEqual({
      ok: true,
      result: { result: 'ready', summary: 'go' },
    });
    expect(agent.invocations).toHaveLength(0);
  });

  it('returns missing when resultJsonPath is not set', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const outcome = await extractResult({
      invocation: makeInvocation({ resultJsonPath: undefined }),
      ports: { artifacts, agent },
      rerunContext: { cwd: '/repo', repoId: 'org/repo' },
    });
    expect(outcome).toEqual({
      ok: false,
      reason: 'missing',
      detail: 'no resultJsonPath on invocation inv-1',
      violationCode: 'invalid_result_json',
    });
    expect(agent.invocations).toHaveLength(0);
  });

  it('returns missing when artifact is not in store', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const outcome = await extractResult({
      invocation: makeInvocation(),
      ports: { artifacts, agent },
      rerunContext: { cwd: '/repo', repoId: 'org/repo' },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('missing');
      expect(outcome.violationCode).toBe('invalid_result_json');
    }
    expect(agent.invocations).toHaveLength(0);
  });

  it('returns invalid when JSON is valid but schema does not match', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'r1',
      relativePath: 'result.json',
      contents: '{"bad": "shape"}',
    });
    const agent = new FakeAgentPort();
    const outcome = await extractResult({
      invocation: makeInvocation(),
      ports: { artifacts, agent },
      rerunContext: { cwd: '/repo', repoId: 'org/repo' },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('invalid');
      expect(outcome.violationCode).toBe('invalid_result_json');
    }
  });
});

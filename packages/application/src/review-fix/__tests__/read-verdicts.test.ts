import { describe, it, expect } from 'vitest';
import { PhaseName, RunId, AgentProfileName, AgentInvocationId } from '@ai-sdlc/domain';
import type { AgentInvocation } from '@ai-sdlc/domain';
import { FakeArtifactStore } from '../../test-doubles/fake-artifact-store.js';
import { FakeAgentPort } from '../../test-doubles/fake-agent-port.js';
import { readReviewVerdict, readFixVerdict } from '../read-verdicts.js';

function invocation(phase: string, resultJsonPath?: string): AgentInvocation {
  return {
    id: AgentInvocationId('inv-1'),
    runId: RunId('run-1'),
    phaseId: PhaseName(phase),
    profile: AgentProfileName('opencode-frontier'),
    runtime: 'opencode',
    provider: 'anthropic',
    model: 'claude-opus-4.7',
    promptPath: '/wt/prompt.md',
    promptChars: 10,
    stdoutPath: '/wt/out.log',
    stderrPath: '/wt/err.log',
    startedAt: new Date('2026-06-14T00:00:00.000Z'),
    startCommitSha: 'abc',
    timeoutMs: 60000,
    contractViolations: [],
    ...(resultJsonPath ? { resultJsonPath } : {}),
  } as AgentInvocation;
}

describe('readReviewVerdict', () => {
  it("returns 'pass' for a valid whole-pr-review result.json", async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({ result: 'pass', findings: [] }),
    });
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(invocation('whole-pr-review', 'result.json'), {
      artifacts,
      agent,
    });
    expect(v).toEqual({ ok: true, verdict: 'pass' });
  });

  it('returns not-ok when result.json is missing (no LLM fallback)', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(invocation('whole-pr-review', undefined), {
      artifacts,
      agent,
    });
    expect(v.ok).toBe(false);
    expect(agent.invocations).toHaveLength(0);
  });
});

describe('readFixVerdict', () => {
  it('maps fix-review result strings', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({ result: 'done_with_fixes' }),
    });
    const agent = new FakeAgentPort();
    const v = await readFixVerdict(invocation('fix-review', 'result.json'), { artifacts, agent });
    expect(v).toEqual({ ok: true, verdict: 'done_with_fixes' });
  });
});

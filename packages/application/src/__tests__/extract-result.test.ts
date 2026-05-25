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

const RERUN_CTX = { cwd: '/repo', repoId: 'org/repo' };

describe('extractResult', () => {
  it('throws on unknown phase', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    await expect(
      extractResult({
        invocation: makeInvocation({ phaseId: PhaseName('nonexistent') }),
        ports: { artifacts, agent },
        rerunContext: RERUN_CTX,
      }),
    ).rejects.toThrow("no result schema registered for phase 'nonexistent'");
  });

  describe('plan-design (retrySafe: true)', () => {
    it('(a) returns typed result on valid input', async () => {
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
        rerunContext: RERUN_CTX,
      });
      expect(outcome).toEqual({ ok: true, result: { result: 'ready', summary: 'go' } });
      expect(agent.invocations).toHaveLength(0);
    });

    it('(b) reruns once and returns ok when rerun produces valid result', async () => {
      const artifacts = new FakeArtifactStore();
      const agent = new FakeAgentPort({
        p: [
          (_req) => {
            void artifacts.write({
              runId: 'r1',
              relativePath: 'result.json',
              contents: JSON.stringify({ result: 'ready', summary: 'go' }),
            });
            return {
              runtime: 'opencode' as const,
              provider: 'a',
              model: 'm',
              exitCode: 0,
              durationMs: 500,
              stdoutPath: '/s2',
              stderrPath: '/e2',
              resultJsonPath: 'result.json',
              contractViolations: [],
              outcome: 'success' as const,
            };
          },
        ],
      });
      const outcome = await extractResult({
        invocation: makeInvocation(),
        ports: { artifacts, agent },
        rerunContext: RERUN_CTX,
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result).toEqual({ result: 'ready', summary: 'go' });
      }
      expect(agent.invocations).toHaveLength(1);
      expect(agent.invocations[0].fallbackOfInvocationId).toBe(AgentInvocationId('inv-1'));
    });

    it('(c) still-invalid after rerun → ok:false, no third LLM call', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'r1',
        relativePath: 'result.json',
        contents: '{"bad": "shape"}',
      });
      const agent = new FakeAgentPort({
        p: [
          (_req) => {
            void artifacts.write({
              runId: 'r1',
              relativePath: 'result.json',
              contents: '{"still": "bad"}',
            });
            return {
              runtime: 'opencode' as const,
              provider: 'a',
              model: 'm',
              exitCode: 0,
              durationMs: 500,
              stdoutPath: '/s2',
              stderrPath: '/e2',
              resultJsonPath: 'result.json',
              contractViolations: [],
              outcome: 'success' as const,
            };
          },
        ],
      });
      const outcome = await extractResult({
        invocation: makeInvocation(),
        ports: { artifacts, agent },
        rerunContext: RERUN_CTX,
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toBe('invalid');
        expect(outcome.violationCode).toBe('invalid_result_json');
      }
      expect(agent.invocations).toHaveLength(1);
    });

    it('returns invalid without rerun when retrySafe:true and no rerunContext and invalid schema', async () => {
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
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toBe('invalid');
      }
      expect(agent.invocations).toHaveLength(0);
    });

    it('invalid schema → rerun → valid result for retrySafe:true', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'r1',
        relativePath: 'result.json',
        contents: '{"bad": "shape"}',
      });
      const agent = new FakeAgentPort({
        p: [
          (_req) => {
            void artifacts.write({
              runId: 'r1',
              relativePath: 'result.json',
              contents: JSON.stringify({ result: 'ready', summary: 'go' }),
            });
            return {
              runtime: 'opencode' as const,
              provider: 'a',
              model: 'm',
              exitCode: 0,
              durationMs: 500,
              stdoutPath: '/s2',
              stderrPath: '/e2',
              resultJsonPath: 'result.json',
              contractViolations: [],
              outcome: 'success' as const,
            };
          },
        ],
      });
      const outcome = await extractResult({
        invocation: makeInvocation(),
        ports: { artifacts, agent },
        rerunContext: RERUN_CTX,
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result).toEqual({ result: 'ready', summary: 'go' });
      }
      expect(agent.invocations).toHaveLength(1);
    });

    it('returns missing when resultJsonPath is not set (no rerunContext)', async () => {
      const artifacts = new FakeArtifactStore();
      const agent = new FakeAgentPort();
      const outcome = await extractResult({
        invocation: makeInvocation({ resultJsonPath: undefined }),
        ports: { artifacts, agent },
      });
      expect(outcome).toEqual({
        ok: false,
        reason: 'missing',
        detail: 'no resultJsonPath on invocation inv-1',
        violationCode: 'invalid_result_json',
      });
      expect(agent.invocations).toHaveLength(0);
    });

    it('returns missing when artifact is not in store (no rerunContext)', async () => {
      const artifacts = new FakeArtifactStore();
      const agent = new FakeAgentPort();
      const outcome = await extractResult({
        invocation: makeInvocation(),
        ports: { artifacts, agent },
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toBe('missing');
        expect(outcome.violationCode).toBe('invalid_result_json');
      }
      expect(agent.invocations).toHaveLength(0);
    });
  });

  describe('implement (retrySafe: false)', () => {
    it('(d) fails immediately without rerun on invalid result', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'r1',
        relativePath: 'result.json',
        contents: '{"bad": "shape"}',
      });
      const agent = new FakeAgentPort();
      const outcome = await extractResult({
        invocation: makeInvocation({ phaseId: PhaseName('implement') }),
        ports: { artifacts, agent },
        rerunContext: RERUN_CTX,
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toBe('invalid');
        expect(outcome.violationCode).toBe('invalid_result_json');
      }
      expect(agent.invocations).toHaveLength(0);
    });

    it('(a) returns typed result on valid input', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'r1',
        relativePath: 'result.json',
        contents: JSON.stringify({ result: 'success', changedFiles: ['src/foo.ts'] }),
      });
      const agent = new FakeAgentPort();
      const outcome = await extractResult({
        invocation: makeInvocation({ phaseId: PhaseName('implement') }),
        ports: { artifacts, agent },
        rerunContext: RERUN_CTX,
      });
      expect(outcome).toEqual({
        ok: true,
        result: { result: 'success', changedFiles: ['src/foo.ts'] },
      });
      expect(agent.invocations).toHaveLength(0);
    });
  });

  describe('caller-side violation recording', () => {
    it('caller can record violation on the invocation after extractResult returns failure', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'r1',
        relativePath: 'result.json',
        contents: '{"bad": "shape"}',
      });
      const agent = new FakeAgentPort();
      const invocation = makeInvocation({ phaseId: PhaseName('implement') });
      const outcome = await extractResult({
        invocation,
        ports: { artifacts, agent },
        rerunContext: RERUN_CTX,
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        const existing = invocation.contractViolations ?? [];
        invocation.contractViolations = [...existing, outcome.violationCode];
      }
      expect(invocation.contractViolations).toContain('invalid_result_json');
    });
  });
});

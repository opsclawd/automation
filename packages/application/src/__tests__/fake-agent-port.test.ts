import { describe, expect, it } from 'vitest';
import { FakeAgentPort } from '../test-doubles/fake-agent-port.js';
import { AgentProfileName } from '../agent/invocation.js';
import type { AgentInvocationRequest, AgentInvocationResult } from '../agent/invocation.js';

function makeRequest(overrides?: Partial<AgentInvocationRequest>): AgentInvocationRequest {
  return {
    profile: AgentProfileName('test'),
    promptPath: '/tmp/p.md',
    expectedArtifacts: ['out.md'],
    cwd: '/tmp/wt',
    runId: 'r1',
    repoId: 'repo1',
    phaseId: 'plan',
    ...overrides,
  };
}

function makeResult(overrides?: Partial<AgentInvocationResult>): AgentInvocationResult {
  return {
    runtime: 'opencode',
    provider: 'anthropic',
    model: 'claude-opus-4.7',
    exitCode: 0,
    durationMs: 100,
    stdoutPath: '/tmp/out.log',
    stderrPath: '/tmp/err.log',
    contractViolations: [],
    outcome: 'success',
    ...overrides,
  };
}

describe('FakeAgentPort', () => {
  describe('FIFO response ordering per profile', () => {
    it('returns scripted responses in order', async () => {
      const port = new FakeAgentPort({
        [AgentProfileName('test')]: [
          makeResult({ outcome: 'success' }),
          makeResult({ outcome: 'failed' }),
        ],
      });

      const r1 = await port.invoke(makeRequest());
      expect(r1.outcome).toBe('success');

      const r2 = await port.invoke(makeRequest());
      expect(r2.outcome).toBe('failed');
    });

    it('returns responses from distinct profiles independently', async () => {
      const port = new FakeAgentPort({
        [AgentProfileName('a')]: [makeResult({ outcome: 'success' })],
        [AgentProfileName('b')]: [makeResult({ outcome: 'timeout' })],
      });

      const rb = await port.invoke(makeRequest({ profile: AgentProfileName('b') }));
      expect(rb.outcome).toBe('timeout');

      const ra = await port.invoke(makeRequest({ profile: AgentProfileName('a') }));
      expect(ra.outcome).toBe('success');
    });
  });

  describe('empty queue error', () => {
    it('throws when no scripted response remains', async () => {
      const port = new FakeAgentPort({
        [AgentProfileName('test')]: [makeResult({ outcome: 'success' })],
      });

      await port.invoke(makeRequest()); // consumes the only response
      await expect(port.invoke(makeRequest())).rejects.toThrow(
        'No scripted response for profile "test"',
      );
    });

    it('throws when no responses were ever scripted for a profile', async () => {
      const port = new FakeAgentPort();

      await expect(port.invoke(makeRequest())).rejects.toThrow(
        'No scripted response for profile "test"',
      );
    });
  });

  describe('callable per-request responses', () => {
    it('invokes a function response with the request', async () => {
      const port = new FakeAgentPort({
        [AgentProfileName('test')]: [
          (req) => makeResult({ contractViolations: [`profile was ${req.profile}`] }),
        ],
      });

      const result = await port.invoke(makeRequest({ profile: AgentProfileName('test') }));
      expect(result.contractViolations).toEqual(['profile was test']);
    });
  });

  describe('invocation recording', () => {
    it('records every invocation', async () => {
      const port = new FakeAgentPort({
        [AgentProfileName('test')]: [
          makeResult({ outcome: 'success' }),
          makeResult({ outcome: 'failed' }),
        ],
      });

      await port.invoke(makeRequest({ runId: 'r1' }));
      await port.invoke(makeRequest({ runId: 'r2' }));

      expect(port.invocations).toHaveLength(2);
      expect(port.invocations[0].runId).toBe('r1');
      expect(port.invocations[1].runId).toBe('r2');
    });
  });
});

import { describe, it, expect } from 'vitest';
import type { AgentInvocation, AgentInvocationOutcome } from '../agent-invocation.js';
import { AgentInvocationId, RunId, PhaseName } from '../ids.js';
import { AgentProfileName } from '../agent-types.js';

describe('AgentInvocation', () => {
  it('compiles with every field populated', () => {
    const inv: AgentInvocation = {
      id: AgentInvocationId('inv-1'),
      runId: RunId('run-1'),
      phaseId: PhaseName('plan-design'),
      stepId: 'step-1',
      profile: AgentProfileName('opencode-frontier'),
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      skill: 'plan',
      promptPath: '/tmp/prompt.md',
      promptChars: 1234,
      promptTokensApprox: 308,
      stdoutPath: '/tmp/stdout.log',
      stderrPath: '/tmp/stderr.log',
      startedAt: new Date('2026-05-22T10:00:00Z'),
      endedAt: new Date('2026-05-22T10:01:30Z'),
      startCommitSha: 'a'.repeat(40),
      endCommitSha: 'b'.repeat(40),
      exitCode: 0,
      durationMs: 90_000,
      timeoutMs: 600_000,
      outcome: 'success' satisfies AgentInvocationOutcome,
      contractViolations: [],
      resultJsonPath: '/tmp/result.json',
      fallbackOfInvocationId: undefined,
    };
    expect(inv.runtime).toBe('opencode');
  });
});

import { describe, it, expect } from 'vitest';
import { PhaseName, RunId, AgentProfileName, AgentInvocationId } from '@ai-sdlc/domain';
import type { AgentInvocation } from '@ai-sdlc/domain';
import { FakeArtifactStore } from '../../test-doubles/fake-artifact-store.js';
import { FakeAgentPort } from '../../test-doubles/fake-agent-port.js';
import { readReviewVerdict } from '../read-verdicts.js';

/**
 * Parity characterization test for #374: the severity gate is authoritative in
 * BOTH directions. The gate lives in `readReviewVerdict` (NOT the loop), so this
 * test drives `readReviewVerdict` directly against real result.json fixtures —
 * mocking `runReview` would bypass the gate entirely and prove nothing.
 *
 * Invariants pinned:
 *  - fail + all findings strictly below threshold  → overridden to pass
 *  - fail + any finding at/above threshold         → stays fail
 *  - fail + empty findings (nothing to weigh)      → stays fail (conservative)
 *  - pass + any finding at/above threshold         → overridden to fail (#371)
 */
function invocation(resultJsonPath = 'result.json'): AgentInvocation {
  return {
    id: AgentInvocationId('inv-1'),
    runId: RunId('run-1'),
    phaseId: PhaseName('whole-pr-review'),
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
    resultJsonPath,
  } as AgentInvocation;
}

async function verdictFor(result: unknown) {
  const artifacts = new FakeArtifactStore();
  await artifacts.write({
    runId: 'run-1',
    relativePath: 'result.json',
    contents: JSON.stringify(result),
  });
  return readReviewVerdict(
    invocation(),
    { artifacts, agent: new FakeAgentPort() },
    { blockOnSeverity: 'high' },
  );
}

describe('parity[#374]: bidirectional severity gate (readReviewVerdict)', () => {
  it('downgrades fail→pass when every finding is strictly below threshold', async () => {
    const v = await verdictFor({
      result: 'fail',
      findings: [
        { severity: 'low', summary: 'style nit' },
        { severity: 'medium', summary: 'minor smell' },
      ],
    });
    expect(v).toEqual({ ok: true, verdict: 'pass', overridden: true, offendingFindings: [] });
  });

  it('keeps fail when any finding is at/above threshold', async () => {
    const v = await verdictFor({
      result: 'fail',
      findings: [{ severity: 'high', summary: 'real bug' }],
    });
    expect(v).toMatchObject({ ok: true, verdict: 'fail' });
  });

  it('keeps fail (conservative) when findings are empty', async () => {
    const v = await verdictFor({ result: 'fail', findings: [] });
    expect(v).toMatchObject({ ok: true, verdict: 'fail' });
  });

  it('upgrades pass→fail when a blocking finding is present (#371 direction)', async () => {
    const v = await verdictFor({
      result: 'pass',
      findings: [{ severity: 'high', summary: 'unused export' }],
    });
    expect(v).toMatchObject({ ok: true, verdict: 'fail', overridden: true });
  });
});

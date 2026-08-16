import { describe, expect, it } from 'vitest';
import { AgentInvocationId, AgentProfileName, PhaseName, RunId } from '@ai-sdlc/domain';
import type { AgentInvocation } from '@ai-sdlc/domain';
import { FakeArtifactStore } from '../../test-doubles/fake-artifact-store.js';
import { FakeAgentPort } from '../../test-doubles/fake-agent-port.js';
import { readReviewVerdict } from '../read-verdicts.js';

function makeQualityReviewInvocation(resultJsonPath: string = 'result.json'): AgentInvocation {
  return {
    id: AgentInvocationId('inv-qual-1'),
    runId: RunId('run-1'),
    phaseId: PhaseName('quality-review'),
    profile: AgentProfileName('opencode-frontier'),
    runtime: 'opencode',
    provider: 'anthropic',
    model: 'claude-opus-4.7',
    promptPath: '/wt/prompt.md',
    promptChars: 10,
    stdoutPath: '/wt/out.log',
    stderrPath: '/wt/err.log',
    startedAt: new Date('2026-08-16T00:00:00.000Z'),
    startCommitSha: 'abc',
    timeoutMs: 60000,
    contractViolations: [],
    resultJsonPath,
  } as AgentInvocation;
}

describe('quality-review fabricated verdict extraction', () => {
  it('preserves a fabricated quality-review verdict without severity-gate rewriting', async () => {
    const artifacts = new FakeArtifactStore();
    const payload = {
      result: 'fabricated',
      findings: [
        {
          severity: 'P0',
          summary: 'The claimed hardware telemetry has no physical execution provenance',
          file: 'certification/transition-soak/result.json',
        },
      ],
    };
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify(payload),
    });
    const agent = new FakeAgentPort();
    const options = {
      blockOnSeverity: 'high',
      allowFabricated: true,
    } as unknown as Parameters<typeof readReviewVerdict>[2];
    const outcome = await readReviewVerdict(
      makeQualityReviewInvocation('result.json'),
      { artifacts, agent },
      options,
    );

    expect(outcome).toEqual({
      ok: true,
      verdict: 'fabricated',
      offendingFindings: [
        {
          severity: 'P0',
          summary: 'The claimed hardware telemetry has no physical execution provenance',
          file: 'certification/transition-soak/result.json',
        },
      ],
    });
  });
});

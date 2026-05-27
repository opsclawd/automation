import { describe, it, expect } from 'vitest';
import { AgentProfileName, RunId } from '@ai-sdlc/domain';
import { FakeAgentInvocationPort } from '@ai-sdlc/application/test-doubles';
import {
  type AgentPort,
  type AgentInvocationRequest,
  type AgentInvocationResult,
  CONTRACT_VIOLATION_CODES,
} from '@ai-sdlc/application';
import { type AgentConfig } from '@ai-sdlc/shared';
import { AgentRuntimeRouter } from '../agent-runtime-router.js';

/**
 * Locks in the semantics around reclassifying cancelled_by_orchestrator → timeout.
 *
 * The reclassification should only fire when the profile timeout signal fired
 * AND the caller signal did NOT. A caller-initiated abort (e.g. user Ctrl-C)
 * that races with a profile timeout should remain classified as a failure so
 * the cancellation signal survives in telemetry / failure.json.
 */

function cfg(): AgentConfig {
  return {
    defaultProfile: 'opencode-frontier',
    profiles: {
      'opencode-frontier': {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        timeoutMinutes: 1,
      },
    },
    phaseProfiles: {
      'plan-design': { profile: 'opencode-frontier' },
    },
  };
}

function makeReq(abortSignal?: AbortSignal): AgentInvocationRequest {
  return {
    profile: AgentProfileName('opencode-frontier'),
    promptPath: '/tmp/p.md',
    expectedArtifacts: [],
    cwd: '/tmp',
    runId: '00000000-0000-0000-0000-000000000020',
    repoId: 'r1',
    phaseId: 'plan-design',
    startCommitSha: 'a'.repeat(40),
    ...(abortSignal ? { abortSignal } : {}),
  };
}

class TimeoutFiringAdapter implements AgentPort {
  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    // Simulate the profile timeout firing by waiting until the composed
    // abort signal aborts, then returning a cancelled outcome.
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (request.abortSignal?.aborted) resolve();
        else setTimeout(check, 5);
      };
      check();
    });
    return {
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'm',
      exitCode: 130,
      durationMs: 10,
      stdoutPath: '/s',
      stderrPath: '/e',
      contractViolations: [CONTRACT_VIOLATION_CODES.CANCELLED_BY_ORCHESTRATOR],
      outcome: 'failed',
    };
  }
}

describe('AgentRuntimeRouter cancellation reclassification', () => {
  it('keeps outcome=failed when caller signal aborted (user Ctrl-C wins over profile timeout)', async () => {
    const inv = new FakeAgentInvocationPort();
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: new TimeoutFiringAdapter() },
      invocationRepository: inv,
      clock: () => new Date('2026-05-27T12:00:00Z'),
      idFactory: () => 'inv-cancel-1',
      readPromptChars: () => 1,
    });

    // Caller pre-aborts to simulate a user Ctrl-C before profile timeout window.
    const callerController = new AbortController();
    callerController.abort();

    const result = await router.invoke(makeReq(callerController.signal));

    // Reclassification must NOT have fired — outcome stays 'failed'.
    expect(result.outcome).toBe('failed');
    expect(result.contractViolations).toContain(CONTRACT_VIOLATION_CODES.CANCELLED_BY_ORCHESTRATOR);

    const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000020'));
    expect(rows[0].outcome).toBe('failed');
  });

  // NOTE: the inverse case (profile timeout fires, no caller signal → outcome
  // reclassified to 'timeout') would require waiting for AbortSignal.timeout
  // to fire on a real interval. The router's existing fallback tests already
  // exercise the timeout outcome path; the guard restored in this PR is the
  // only branch this file is responsible for.
});

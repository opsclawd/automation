import { describe, it, expect } from 'vitest';
import { AgentProfileName, RunId } from '@ai-sdlc/domain';
import { FakeAgentInvocationPort } from '@ai-sdlc/application/test-doubles';
import type { AgentPort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
import { CONTRACT_VIOLATION_CODES } from '@ai-sdlc/application/ports';
import { type AgentConfig } from '@ai-sdlc/shared';
import { AgentRuntimeRouter } from '../agent-runtime-router.js';

/**
 * Locks in the semantics around reclassifying cancelled_by_orchestrator → timeout.
 *
 * The reclassification fires when EITHER the profile timeout signal or the
 * caller's AbortSignal.timeout() aborted — but NOT when the caller initiated
 * a bare abort (e.g. user Ctrl-C). This ensures the fallback path activates
 * for genuine timeouts while preserving cancellation signal in telemetry when
 * the user explicitly cancels.
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
      'plan-design': { profile: 'opencode-frontier', fallbackProfile: 'opencode-frontier' },
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

class SignalAwareAdapter implements AgentPort {
  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    await new Promise<void>((resolve) => {
      if (request.abortSignal?.aborted) {
        resolve();
      } else {
        request.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
      }
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
  it('reclassifies to timeout when caller AbortSignal.timeout() fires (production path)', async () => {
    const inv = new FakeAgentInvocationPort();
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: new SignalAwareAdapter() },
      invocationRepository: inv,
      clock: () => new Date('2026-05-27T12:00:00Z'),
      idFactory: () => 'inv-timeout-1',
      readPromptChars: () => 1,
    });

    const callerSignal = AbortSignal.timeout(50);
    const result = await router.invoke(makeReq(callerSignal));

    expect(result.outcome).toBe('timeout');
    expect(result.contractViolations).toEqual([]);

    const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000020'));
    expect(rows[0].outcome).toBe('timeout');
  });

  it('keeps outcome=failed when caller abort is bare controller.abort() (user Ctrl-C)', async () => {
    const inv = new FakeAgentInvocationPort();
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: new SignalAwareAdapter() },
      invocationRepository: inv,
      clock: () => new Date('2026-05-27T12:00:00Z'),
      idFactory: () => 'inv-cancel-1',
      readPromptChars: () => 1,
    });

    const callerController = new AbortController();
    callerController.abort();

    const result = await router.invoke(makeReq(callerController.signal));

    expect(result.outcome).toBe('failed');
    expect(result.contractViolations).toContain(CONTRACT_VIOLATION_CODES.CANCELLED_BY_ORCHESTRATOR);

    const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000020'));
    expect(rows[0].outcome).toBe('failed');
  });
});

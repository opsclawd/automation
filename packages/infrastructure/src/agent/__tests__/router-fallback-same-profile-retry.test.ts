import { describe, it, expect } from 'vitest';
import { AgentInvocationId, AgentProfileName, RunId } from '@ai-sdlc/domain';
import { FakeAgentInvocationPort } from '@ai-sdlc/application/test-doubles';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
import { type AgentConfig, type OrchestratorEvent } from '@ai-sdlc/shared';
import { AgentRuntimeRouter } from '../agent-runtime-router.js';

// #1318: follow-up-review's same-profile correction-retry / empty-response-retry
// (run-single-shot-agent-phase.ts) reuses `fallbackOfInvocationId` purely for
// invocation-chain bookkeeping — it re-invokes the *same* profile with a
// corrected prompt, it does not switch profiles. If that retry itself also
// fails (timeout or contract_violation), the phase's normal PHASE_FALLBACKS
// escalation to a different, configured fallback profile must still get a
// chance, rather than permanently blocking the phase on a flaky primary
// model. This is the inverse of router-fallback-caller-signal.test.ts, which
// covers the genuine cross-profile case (correctly still suppressed).

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
      'pi-local': {
        runtime: 'pi',
        provider: 'local',
        model: 'q',
        timeoutMinutes: 1,
        contextLimitTokens: 64000,
      },
    },
    phaseProfiles: {
      'follow-up-review': { profile: 'opencode-frontier', fallbackProfile: 'pi-local' },
    },
  };
}

function req(overrides: Partial<AgentInvocationRequest> = {}): AgentInvocationRequest {
  return {
    profile: AgentProfileName('opencode-frontier'),
    promptPath: '/tmp/prompt.md',
    expectedArtifacts: [],
    cwd: '/tmp',
    runId: '00000000-0000-0000-0000-000000000001',
    repoId: 'r1',
    phaseId: 'follow-up-review',
    startCommitSha: 'a'.repeat(40),
    ...overrides,
  };
}

const FIXED_NOW = new Date('2026-05-22T12:00:00.000Z');

describe('AgentRuntimeRouter same-profile chained retry (#1318)', () => {
  it('still escalates to the configured fallback profile when a same-profile retry also times out', async () => {
    const inv = new FakeAgentInvocationPort();

    const opencodeResult: AgentInvocationResult = {
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'm',
      exitCode: 0,
      durationMs: 1800000,
      stdoutPath: '/s',
      stderrPath: '/e',
      contractViolations: [],
      outcome: 'timeout',
    };
    const piResult: AgentInvocationResult = {
      runtime: 'pi',
      provider: 'local',
      model: 'q',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/s2',
      stderrPath: '/e2',
      contractViolations: [],
      outcome: 'success',
    };

    const events: OrchestratorEvent[] = [];
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: {
        opencode: {
          async invoke() {
            return opencodeResult;
          },
        },
        pi: {
          async invoke() {
            return piResult;
          },
        },
      },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-fallback',
      readPromptChars: () => 100,
      eventBus: {
        publish(_runId, ev) {
          if (ev.type === 'phase.fallback.escalated') events.push(ev);
        },
      },
    });

    // The original invocation (opencode-frontier) already failed and the
    // use-case layer (run-single-shot-agent-phase.ts) issued a same-profile
    // correction retry, chaining fallbackOfInvocationId back to it purely
    // for traceability.
    inv.insert({
      id: AgentInvocationId('prev-invocation'),
      runId: RunId('00000000-0000-0000-0000-000000000001'),
      profile: AgentProfileName('opencode-frontier'),
      runtime: 'opencode' as const,
      provider: 'anthropic',
      model: 'm',
      promptPath: '/tmp/prompt.md',
      promptChars: 50,
      stdoutPath: '',
      stderrPath: '',
      startedAt: FIXED_NOW,
      startCommitSha: 'a'.repeat(40),
      timeoutMs: 60000,
      contractViolations: [],
    });

    const result = await router.invoke(
      req({
        fallbackOfInvocationId: AgentInvocationId('prev-invocation'),
        fallbackReason: 'correction_retry_missing_artifact',
      }),
    );

    // The same-profile retry also timed out, so the router should have
    // escalated to the configured fallback profile (pi-local) and returned
    // its success, rather than returning the retry's own timeout.
    expect(result.outcome).toBe('success');
    expect(result.model).toBe('q');

    const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
    // prev-invocation + the same-profile retry + the router's fallback dispatch
    expect(rows.length).toBe(3);
    expect(rows[2].profile).toBe('pi-local');

    // One event for the use-case-signalled chain (prev-invocation -> retry),
    // one for the router's own escalation (retry -> fallback).
    expect(events.length).toBe(2);
    expect(events[0].metadata.triggerOwner).toBe('use_case');
    expect(events[1].metadata.triggerOwner).toBe('router');
    expect(events[1].metadata.fromProfile).toBe('opencode-frontier');
    expect(events[1].metadata.toProfile).toBe('pi-local');
  });
});

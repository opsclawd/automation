import { describe, it, expect } from 'vitest';
import { AgentInvocationId, AgentProfileName, RunId } from '@ai-sdlc/domain';
import { FakeAgentInvocationPort } from '@ai-sdlc/application/test-doubles';
import {
  type AgentPort,
  type AgentInvocationRequest,
  type AgentInvocationResult,
} from '@ai-sdlc/application';
import { type AgentConfig, type OrchestratorEvent } from '@ai-sdlc/shared';
import { AgentRuntimeRouter } from '../agent-runtime-router.js';

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
      'plan-design': { profile: 'opencode-frontier', fallbackProfile: 'pi-local' },
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
    phaseId: 'plan-design',
    startCommitSha: 'a'.repeat(40),
    ...overrides,
  };
}

class StubAdapter implements AgentPort {
  constructor(private readonly result: AgentInvocationResult) {}
  async invoke(_: AgentInvocationRequest): Promise<AgentInvocationResult> {
    return this.result;
  }
}

const FIXED_NOW = new Date('2026-05-22T12:00:00.000Z');

describe('AgentRuntimeRouter caller-signalled fallback', () => {
  it('honours caller-set fallbackOfInvocationId and emits with triggerOwner: use_case', async () => {
    const inv = new FakeAgentInvocationPort();
    const adapter = new StubAdapter({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'm',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/s',
      stderrPath: '/e',
      contractViolations: [],
      outcome: 'success',
    });
    const events: OrchestratorEvent[] = [];
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: adapter, pi: adapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-caller',
      readPromptChars: () => 100,
      eventBus: {
        publish(_runId, ev) {
          events.push(ev);
        },
      },
    });

    const result = await router.invoke(
      req({
        fallbackOfInvocationId: AgentInvocationId('prev-invocation'),
        fallbackReason: 'two consecutive failures on same step',
      }),
    );

    // Result is from the fallback profile
    expect(result.outcome).toBe('success');

    // Two rows: first (original) + second (fallback)
    const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
    expect(rows.length).toBe(2);

    // First row has the caller-provided fallbackOfInvocationId
    expect(rows[0].fallbackOfInvocationId).toBeDefined();
    expect(String(rows[0].fallbackOfInvocationId)).toBe('prev-invocation');

    // Second row is the fallback invocation, recording what it fell back from
    expect(rows[1].fallbackOfInvocationId).toBeDefined();
    expect(String(rows[1].fallbackOfInvocationId)).toBe('inv-caller');

    // Event emitted with triggerOwner: 'use_case'
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('phase.fallback.escalated');
    expect(events[0].metadata.triggerOwner).toBe('use_case');
    expect(events[0].metadata.triggerReason).toBe('two consecutive failures on same step');
    expect(events[0].metadata.fromProfile).toBe('opencode-frontier');
    expect(events[0].metadata.toProfile).toBe('pi-local');
  });
});

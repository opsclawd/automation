import { describe, it, expect } from 'vitest';
import { AgentInvocationId, AgentProfileName, RunId } from '@ai-sdlc/domain';
import { FakeAgentInvocationPort } from '@ai-sdlc/application/test-doubles';
import type { AgentPort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
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
    profile: AgentProfileName('pi-local'),
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

const FIXED_NOW = new Date('2026-05-22T12:00:00.000Z');

describe('AgentRuntimeRouter caller-signalled fallback', () => {
  it('emits event before invocation and does not escalate further', async () => {
    const inv = new FakeAgentInvocationPort();
    const piResult: AgentInvocationResult = {
      runtime: 'pi',
      provider: 'local',
      model: 'q',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/s',
      stderrPath: '/e',
      contractViolations: [],
      outcome: 'success',
    };
    const events: OrchestratorEvent[] = [];
    let eventsAtInvokeTime: OrchestratorEvent[] = [];

    const piAdapter: AgentPort = {
      async invoke(_: AgentInvocationRequest): Promise<AgentInvocationResult> {
        eventsAtInvokeTime = [...events];
        return piResult;
      },
    };

    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: {} as AgentPort, pi: piAdapter },
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

    const previousInv = {
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
    };
    inv.insert(previousInv);

    const result = await router.invoke(
      req({
        fallbackOfInvocationId: AgentInvocationId('prev-invocation'),
        fallbackReason: 'two consecutive failures on same step',
      }),
    );

    expect(result.outcome).toBe('success');

    const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
    expect(rows.length).toBe(2);
    expect(rows[0].profile).toBe('opencode-frontier');

    expect(rows[1].fallbackOfInvocationId).toBeDefined();
    expect(String(rows[1].fallbackOfInvocationId)).toBe('prev-invocation');
    expect(rows[1].profile).toBe('pi-local');

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('phase.fallback.escalated');
    expect(events[0].metadata.triggerOwner).toBe('use_case');
    expect(events[0].metadata.triggerReason).toBe('two consecutive failures on same step');
    expect(events[0].metadata.fromProfile).toBe('opencode-frontier');
    expect(events[0].metadata.toProfile).toBe('pi-local');

    expect(eventsAtInvokeTime.length).toBe(1);
  });

  it('truncates fallbackReason to 64 characters', async () => {
    const inv = new FakeAgentInvocationPort();
    const piAdapter: AgentPort = {
      async invoke(_: AgentInvocationRequest): Promise<AgentInvocationResult> {
        return {
          runtime: 'pi',
          provider: 'local',
          model: 'q',
          exitCode: 0,
          durationMs: 1000,
          stdoutPath: '/s',
          stderrPath: '/e',
          contractViolations: [],
          outcome: 'success',
        };
      },
    };
    const events: OrchestratorEvent[] = [];
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: {} as AgentPort, pi: piAdapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-truncate',
      readPromptChars: () => 100,
      eventBus: {
        publish(_runId, ev) {
          events.push(ev);
        },
      },
    });

    const previousInv = {
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
    };
    inv.insert(previousInv);

    const longReason = 'a'.repeat(80);
    await router.invoke(
      req({
        fallbackOfInvocationId: AgentInvocationId('prev-invocation'),
        fallbackReason: longReason,
      }),
    );

    expect(events[0].metadata.triggerReason).toBe('a'.repeat(64));
  });

  it('does not escalate further even when the invocation fails', async () => {
    const inv = new FakeAgentInvocationPort();
    const piAdapter: AgentPort = {
      async invoke(_: AgentInvocationRequest): Promise<AgentInvocationResult> {
        return {
          runtime: 'pi',
          provider: 'local',
          model: 'q',
          exitCode: 1,
          durationMs: 500,
          stdoutPath: '/s',
          stderrPath: '/e',
          contractViolations: [],
          outcome: 'timeout',
        };
      },
    };
    const events: OrchestratorEvent[] = [];
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: {} as AgentPort, pi: piAdapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-caller-no-escalate',
      readPromptChars: () => 100,
      eventBus: {
        publish(_runId, ev) {
          events.push(ev);
        },
      },
    });

    const previousInv = {
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
    };
    inv.insert(previousInv);

    const result = await router.invoke(
      req({
        fallbackOfInvocationId: AgentInvocationId('prev-invocation'),
        fallbackReason: 'two consecutive failures on same step',
      }),
    );

    expect(result.outcome).toBe('timeout');

    const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
    expect(rows.length).toBe(2);

    expect(events.length).toBe(1);
    expect(events[0].metadata.triggerOwner).toBe('use_case');
  });
});

import { describe, it, expect } from 'vitest';
import {
  AgentInvocationId,
  AgentProfileName,
  PhaseName,
  RunId,
  type AgentInvocation,
} from '@ai-sdlc/domain';
import { FakeAgentInvocationPort } from '../test-doubles/fake-agent-invocation-port.js';

function sample(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    id: AgentInvocationId('inv-' + Math.random().toString(36).slice(2)),
    runId: RunId('run-1'),
    phaseId: PhaseName('plan-design'),
    profile: AgentProfileName('p1'),
    runtime: 'opencode',
    provider: 'anthropic',
    model: 'm',
    promptPath: '/p',
    promptChars: 1,
    stdoutPath: '/s',
    stderrPath: '/e',
    startedAt: new Date(),
    startCommitSha: 'a'.repeat(40),
    timeoutMs: 1000,
    ...overrides,
  };
}

function providerFailure(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return sample({
    outcome: 'failed',
    contractViolations: ['provider_error'],
    endedAt: new Date(),
    ...overrides,
  });
}

describe('FakeAgentInvocationPort', () => {
  it('inserts and finds by id', () => {
    const port = new FakeAgentInvocationPort();
    const inv = sample();
    port.insert(inv);
    expect(port.findById(inv.id)).toEqual(inv);
  });
  it('updates by id', () => {
    const port = new FakeAgentInvocationPort();
    const inv = sample();
    port.insert(inv);
    port.update(inv.id, { outcome: 'success', exitCode: 0, durationMs: 1000 });
    const got = port.findById(inv.id);
    expect(got?.outcome).toBe('success');
    expect(got?.exitCode).toBe(0);
  });
  it('lists by run', () => {
    const port = new FakeAgentInvocationPort();
    port.insert(sample({ id: AgentInvocationId('a'), runId: RunId('r1') }));
    port.insert(sample({ id: AgentInvocationId('b'), runId: RunId('r1') }));
    port.insert(sample({ id: AgentInvocationId('c'), runId: RunId('r2') }));
    expect(port.listByRun(RunId('r1')).map((i) => i.id)).toEqual(['a', 'b']);
  });
  it('lists by run and phase', () => {
    const port = new FakeAgentInvocationPort();
    port.insert(sample({ id: AgentInvocationId('a'), phaseId: PhaseName('p1') }));
    port.insert(sample({ id: AgentInvocationId('b'), phaseId: PhaseName('p2') }));
    expect(port.listByRunAndPhase(RunId('run-1'), PhaseName('p1')).map((i) => i.id)).toEqual(['a']);
  });
  it('lists by runtime', () => {
    const port = new FakeAgentInvocationPort();
    port.insert(sample({ id: AgentInvocationId('a'), runtime: 'opencode' }));
    port.insert(sample({ id: AgentInvocationId('b'), runtime: 'pi' }));
    expect(port.listByRuntime('pi').map((i) => i.id)).toEqual(['b']);
  });
  it('update throws on unknown id', () => {
    const port = new FakeAgentInvocationPort();
    expect(() => port.update(AgentInvocationId('missing'), {})).toThrow();
  });

  it('counts only the newest consecutive provider failures for a profile', () => {
    const port = new FakeAgentInvocationPort();
    const p1 = AgentProfileName('p1');
    const base = new Date('2026-05-22T10:00:00.000Z').getTime();

    port.insert(
      sample({
        profile: p1,
        outcome: 'success',
        startedAt: new Date(base),
        endedAt: new Date(base + 1000),
      }),
    );
    port.insert(
      providerFailure({
        profile: p1,
        startedAt: new Date(base + 2000),
        endedAt: new Date(base + 3000),
      }),
    );
    port.insert(
      providerFailure({
        profile: p1,
        startedAt: new Date(base + 4000),
        endedAt: new Date(base + 5000),
      }),
    );

    expect(port.countConsecutiveProviderFailures(p1)).toBe(2);
  });

  it('resets the provider failure streak after a non-provider completion', () => {
    const port = new FakeAgentInvocationPort();
    const p1 = AgentProfileName('p1');
    const base = new Date('2026-05-22T10:00:00.000Z').getTime();

    port.insert(
      providerFailure({
        profile: p1,
        startedAt: new Date(base),
        endedAt: new Date(base + 1000),
      }),
    );
    port.insert(
      sample({
        profile: p1,
        outcome: 'failed',
        contractViolations: ['contract_violation'],
        startedAt: new Date(base + 2000),
        endedAt: new Date(base + 3000),
      }),
    );

    expect(port.countConsecutiveProviderFailures(p1)).toBe(0);
  });

  it('ignores other profiles and unfinished invocations in the provider failure streak', () => {
    const port = new FakeAgentInvocationPort();
    const p1 = AgentProfileName('p1');
    const p2 = AgentProfileName('p2');
    const base = new Date('2026-05-22T10:00:00.000Z').getTime();

    port.insert(
      providerFailure({
        profile: p1,
        startedAt: new Date(base),
        endedAt: new Date(base + 1000),
      }),
    );
    port.insert(
      providerFailure({
        profile: p1,
        startedAt: new Date(base + 2000),
        endedAt: new Date(base + 3000),
      }),
    );
    port.insert(
      sample({
        profile: p2,
        outcome: 'success',
        startedAt: new Date(base + 4000),
        endedAt: new Date(base + 5000),
      }),
    );
    port.insert(
      sample({
        profile: p1,
        startedAt: new Date(base + 6000),
        endedAt: undefined,
      }),
    );

    expect(port.countConsecutiveProviderFailures(p1)).toBe(2);
  });

  it('orders equal timestamps deterministically when counting provider failures', () => {
    const port = new FakeAgentInvocationPort();
    const p1 = AgentProfileName('p1');
    const sameTime = new Date('2026-05-22T10:00:00.000Z');

    port.insert(
      providerFailure({ id: AgentInvocationId('inv-1'), profile: p1, startedAt: sameTime }),
    );
    port.insert(
      sample({
        id: AgentInvocationId('inv-2'),
        profile: p1,
        outcome: 'success',
        startedAt: sameTime,
        endedAt: sameTime,
      }),
    );
    port.insert(
      providerFailure({ id: AgentInvocationId('inv-3'), profile: p1, startedAt: sameTime }),
    );

    expect(port.countConsecutiveProviderFailures(p1)).toBe(1);
  });
});

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
});

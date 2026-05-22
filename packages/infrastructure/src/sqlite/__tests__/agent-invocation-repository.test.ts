import { describe, it, expect } from 'vitest';
import {
  AgentInvocationId,
  AgentProfileName,
  PhaseName,
  RunId,
  type AgentInvocation,
} from '@ai-sdlc/domain';
import { openDatabase, applyMigrations, RunRepository } from '../../index.js';
import { AgentInvocationRepository } from '../agent-invocation-repository.js';

function sample(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    id: AgentInvocationId('inv-1'),
    runId: RunId('00000000-0000-0000-0000-000000000001'),
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
    startedAt: new Date('2026-05-22T10:00:00.000Z'),
    endedAt: new Date('2026-05-22T10:01:30.000Z'),
    startCommitSha: 'a'.repeat(40),
    endCommitSha: 'b'.repeat(40),
    exitCode: 0,
    durationMs: 90_000,
    timeoutMs: 600_000,
    outcome: 'success',
    contractViolations: ['x_violation', 'y_violation'],
    resultJsonPath: '/tmp/result.json',
    ...overrides,
  };
}

function setupDb() {
  const db = openDatabase(':memory:');
  applyMigrations(db);
  const runs = new RunRepository(db);
  runs.insertIfNoActive({
    uuid: '00000000-0000-0000-0000-000000000001',
    displayId: 'run-1',
    issueNumber: 1,
    type: 'issue',
    status: 'running',
    completedPhases: [],
    startedAt: new Date(),
  } as never);
  return { db };
}

describe('AgentInvocationRepository', () => {
  it('round-trips an invocation with every field', () => {
    const { db } = setupDb();
    const repo = new AgentInvocationRepository(db);
    const inv = sample();
    repo.insert(inv);
    const got = repo.findById(inv.id);
    expect(got).toEqual(inv);
    expect(got?.startedAt).toBeInstanceOf(Date);
  });
  it('updates outcome + endedAt', () => {
    const { db } = setupDb();
    const repo = new AgentInvocationRepository(db);
    const inv = sample({ outcome: undefined, endedAt: undefined, contractViolations: undefined });
    repo.insert(inv);
    repo.update(inv.id, {
      outcome: 'failed',
      endedAt: new Date('2026-05-22T10:02:00.000Z'),
      exitCode: 1,
      durationMs: 120_000,
      contractViolations: ['boom'],
    });
    const got = repo.findById(inv.id);
    expect(got?.outcome).toBe('failed');
    expect(got?.exitCode).toBe(1);
    expect(got?.contractViolations).toEqual(['boom']);
    expect(got?.endedAt).toEqual(new Date('2026-05-22T10:02:00.000Z'));
  });
  it('lists by run and by run+phase', () => {
    const { db } = setupDb();
    const repo = new AgentInvocationRepository(db);
    repo.insert(sample({ id: AgentInvocationId('a'), phaseId: PhaseName('p1') }));
    repo.insert(sample({ id: AgentInvocationId('b'), phaseId: PhaseName('p1') }));
    repo.insert(sample({ id: AgentInvocationId('c'), phaseId: PhaseName('p2') }));
    const r1 = repo.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
    expect(r1.map((i) => i.id).sort()).toEqual(['a', 'b', 'c']);
    const p1 = repo.listByRunAndPhase(
      RunId('00000000-0000-0000-0000-000000000001'),
      PhaseName('p1'),
    );
    expect(p1.map((i) => i.id).sort()).toEqual(['a', 'b']);
  });
  it('lists by runtime', () => {
    const { db } = setupDb();
    const repo = new AgentInvocationRepository(db);
    repo.insert(sample({ id: AgentInvocationId('a'), runtime: 'opencode' }));
    repo.insert(sample({ id: AgentInvocationId('b'), runtime: 'pi' }));
    expect(repo.listByRuntime('pi').map((i) => i.id)).toEqual(['b']);
  });
});

import { describe, it, expect } from 'vitest';
import {
  AgentInvocationId,
  AgentProfileName,
  PhaseName,
  RunId,
  type AgentUsage,
} from '@ai-sdlc/domain';
import { openDatabase, applyMigrations, RunRepository } from '../../index.js';
import { AgentUsageRepository } from '../agent-usage-repository.js';

function sample(overrides: Partial<AgentUsage> = {}): AgentUsage {
  return {
    invocationId: AgentInvocationId('inv-1'),
    runId: RunId('00000000-0000-0000-0000-000000000001'),
    phaseId: PhaseName('plan-design'),
    profile: AgentProfileName('opencode-frontier'),
    provider: 'deepseek',
    model: 'deepseek-pro',
    inputTokens: 1234,
    outputTokens: 567,
    reasoningTokens: 100,
    cachedTokens: 42,
    recordedAt: new Date('2026-06-01T12:00:00.000Z'),
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
  // Seed a parent invocation row (FK requirement)
  db.prepare(
    `INSERT INTO agent_invocations (
    id, run_uuid, phase_id, profile, runtime, provider, model,
    prompt_path, prompt_chars, stdout_path, stderr_path, started_at,
    start_commit_sha, timeout_ms, contract_violations
  ) VALUES (
    @id, @runId, @phaseId, @profile, @runtime, @provider, @model,
    @promptPath, @promptChars, @stdoutPath, @stderrPath, @startedAt,
    @startCommitSha, @timeoutMs, @contractViolations
  )`,
  ).run({
    id: 'inv-1',
    runId: '00000000-0000-0000-0000-000000000001',
    phaseId: 'plan-design',
    profile: 'opencode-frontier',
    runtime: 'opencode',
    provider: 'deepseek',
    model: 'deepseek-pro',
    promptPath: '/tmp/p.md',
    promptChars: 100,
    stdoutPath: '/tmp/o',
    stderrPath: '/tmp/e',
    startedAt: '2026-06-01T11:00:00.000Z',
    startCommitSha: 'a'.repeat(40),
    timeoutMs: 600000,
    contractViolations: '[]',
  });
  // Seed a second invocation for list tests
  db.prepare(
    `INSERT INTO agent_invocations (
    id, run_uuid, phase_id, profile, runtime, provider, model,
    prompt_path, prompt_chars, stdout_path, stderr_path, started_at,
    start_commit_sha, timeout_ms, contract_violations
  ) VALUES (
    @id, @runId, @phaseId, @profile, @runtime, @provider, @model,
    @promptPath, @promptChars, @stdoutPath, @stderrPath, @startedAt,
    @startCommitSha, @timeoutMs, @contractViolations
  )`,
  ).run({
    id: 'inv-2',
    runId: '00000000-0000-0000-0000-000000000001',
    phaseId: 'implement',
    profile: 'opencode-frontier',
    runtime: 'opencode',
    provider: 'deepseek',
    model: 'deepseek',
    promptPath: '/tmp/p2.md',
    promptChars: 200,
    stdoutPath: '/tmp/o2',
    stderrPath: '/tmp/e2',
    startedAt: '2026-06-01T11:05:00.000Z',
    startCommitSha: 'b'.repeat(40),
    timeoutMs: 600000,
    contractViolations: '[]',
  });
  return { db };
}

describe('AgentUsageRepository', () => {
  it('round-trips usage with every field', () => {
    const { db } = setupDb();
    const repo = new AgentUsageRepository(db);
    const usage = sample();
    repo.insert(usage);
    const got = repo.findById(usage.invocationId);
    expect(got).toEqual(usage);
    expect(got?.recordedAt).toBeInstanceOf(Date);
  });

  it('stores usage with only required fields (no optional tokens)', () => {
    const { db } = setupDb();
    const repo = new AgentUsageRepository(db);
    const usage = sample({
      invocationId: AgentInvocationId('inv-2'),
      reasoningTokens: undefined,
      cachedTokens: undefined,
    });
    repo.insert(usage);
    const got = repo.findById(usage.invocationId);
    expect(got?.inputTokens).toBe(1234);
    expect(got?.outputTokens).toBe(567);
    expect(got?.reasoningTokens).toBeUndefined();
    expect(got?.cachedTokens).toBeUndefined();
  });

  it('lists by run', () => {
    const { db } = setupDb();
    const repo = new AgentUsageRepository(db);
    repo.insert(sample({ invocationId: AgentInvocationId('inv-1') }));
    repo.insert(
      sample({ invocationId: AgentInvocationId('inv-2'), phaseId: PhaseName('implement') }),
    );
    const all = repo.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
    expect(all.map((u) => u.invocationId).sort()).toEqual(['inv-1', 'inv-2']);
  });

  it('lists by run and phase', () => {
    const { db } = setupDb();
    const repo = new AgentUsageRepository(db);
    repo.insert(
      sample({ invocationId: AgentInvocationId('inv-1'), phaseId: PhaseName('plan-design') }),
    );
    repo.insert(
      sample({ invocationId: AgentInvocationId('inv-2'), phaseId: PhaseName('implement') }),
    );
    const planUsage = repo.listByRunAndPhase(
      RunId('00000000-0000-0000-0000-000000000001'),
      PhaseName('plan-design'),
    );
    expect(planUsage.map((u) => u.invocationId)).toEqual(['inv-1']);
  });

  it('returns undefined for missing invocation', () => {
    const { db } = setupDb();
    const repo = new AgentUsageRepository(db);
    expect(repo.findById(AgentInvocationId('nonexistent'))).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import { openDatabase, applyMigrations, MIGRATIONS } from '../../index.js';

function setupLegacyDbThrough35() {
  const db = openDatabase(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);

  for (const m of MIGRATIONS.filter((m) => m.version <= 35)) {
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      m.version,
      new Date().toISOString(),
    );
  }

  return db;
}

function seedBaseRunAndInvocations(db: ReturnType<typeof openDatabase>) {
  db.prepare(
    `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at)
     VALUES ('run-1', 'run-1', 1, 'issue', 'running', '[]', '2026-01-01T00:00:00.000Z')`,
  ).run();

  const insertInv = db.prepare(
    `INSERT INTO agent_invocations (
      id, run_uuid, phase_id, profile, runtime, provider, model,
      prompt_path, prompt_chars, stdout_path, stderr_path, started_at, ended_at,
      start_commit_sha, timeout_ms, contract_violations
    ) VALUES (
      @id, @runId, @phaseId, @profile, @runtime, @provider, @model,
      @promptPath, @promptChars, @stdoutPath, @stderrPath, @startedAt, @endedAt,
      @startCommitSha, @timeoutMs, @contractViolations
    )`,
  );

  // inv-1: completed, already had usage
  insertInv.run({
    id: 'inv-1',
    runId: 'run-1',
    phaseId: 'plan',
    profile: 'opencode-frontier',
    runtime: 'opencode',
    provider: 'deepseek',
    model: 'deepseek-pro',
    promptPath: '/tmp/p1.md',
    promptChars: 100,
    stdoutPath: '/tmp/o1',
    stderrPath: '/tmp/e1',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    startCommitSha: 'a'.repeat(40),
    timeoutMs: 600000,
    contractViolations: '[]',
  });

  // inv-2: completed, missing usage
  insertInv.run({
    id: 'inv-2',
    runId: 'run-1',
    phaseId: 'implement',
    profile: 'opencode-frontier',
    runtime: 'opencode',
    provider: 'deepseek',
    model: 'deepseek-pro',
    promptPath: '/tmp/p2.md',
    promptChars: 100,
    stdoutPath: '/tmp/o2',
    stderrPath: '/tmp/e2',
    startedAt: '2026-01-01T00:02:00.000Z',
    endedAt: '2026-01-01T00:03:00.000Z',
    startCommitSha: 'a'.repeat(40),
    timeoutMs: 600000,
    contractViolations: '[]',
  });

  // inv-3: in-flight (ended_at is null), missing usage
  insertInv.run({
    id: 'inv-3',
    runId: 'run-1',
    phaseId: 'validate',
    profile: 'opencode-frontier',
    runtime: 'opencode',
    provider: 'deepseek',
    model: 'deepseek-pro',
    promptPath: '/tmp/p3.md',
    promptChars: 100,
    stdoutPath: '/tmp/o3',
    stderrPath: '/tmp/e3',
    startedAt: '2026-01-01T00:04:00.000Z',
    endedAt: null,
    startCommitSha: 'a'.repeat(40),
    timeoutMs: 600000,
    contractViolations: '[]',
  });

  // Insert model prices
  db.prepare(
    `INSERT INTO model_prices (provider, model, effective_from, input_price_per_1k_tokens, output_price_per_1k_tokens, cached_input_price_per_1k_tokens)
     VALUES ('deepseek', 'deepseek-pro', '2026-01-01', 3.0, 15.0, 0.3)`,
  ).run();
}

describe('migration 0036 agent-usage-status', () => {
  it('preserves existing usage as measured and backfills only completed missing invocations', () => {
    const db = setupLegacyDbThrough35();
    seedBaseRunAndInvocations(db);

    // Insert legacy measured usage row before 0036
    db.prepare(
      `INSERT INTO agent_usage (
        invocation_id, run_uuid, phase_id, profile, provider, model,
        input_tokens, output_tokens, reasoning_tokens, cached_tokens, recorded_at
      ) VALUES (
        'inv-1', 'run-1', 'plan', 'opencode-frontier', 'deepseek', 'deepseek-pro',
        1000, 500, 100, 200, '2026-01-01T00:01:00.000Z'
      )`,
    ).run();

    // Apply migration 0036
    applyMigrations(db);

    // Assert exact preexisting token values and status for inv-1
    const measuredRow = db
      .prepare('SELECT * FROM agent_usage WHERE invocation_id = ?')
      .get('inv-1') as Record<string, unknown>;
    expect(measuredRow).toMatchObject({
      invocation_id: 'inv-1',
      run_uuid: 'run-1',
      phase_id: 'plan',
      profile: 'opencode-frontier',
      provider: 'deepseek',
      model: 'deepseek-pro',
      usage_status: 'measured',
      input_tokens: 1000,
      output_tokens: 500,
      reasoning_tokens: 100,
      cached_tokens: 200,
      recorded_at: '2026-01-01T00:01:00.000Z',
    });

    // Assert backfilled unknown row for completed missing inv-2
    const unknownRow = db
      .prepare('SELECT * FROM agent_usage WHERE invocation_id = ?')
      .get('inv-2') as Record<string, unknown>;
    expect(unknownRow).toMatchObject({
      invocation_id: 'inv-2',
      run_uuid: 'run-1',
      phase_id: 'implement',
      profile: 'opencode-frontier',
      provider: 'deepseek',
      model: 'deepseek-pro',
      usage_status: 'unknown',
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cached_tokens: null,
      recorded_at: '2026-01-01T00:03:00.000Z',
    });

    // Assert in-flight inv-3 was not backfilled
    const inflightRow = db
      .prepare('SELECT * FROM agent_usage WHERE invocation_id = ?')
      .get('inv-3');
    expect(inflightRow).toBeUndefined();

    // Assert v_usage_by_phase
    const phaseRows = db
      .prepare('SELECT * FROM v_usage_by_phase ORDER BY phase_id ASC')
      .all() as Array<Record<string, unknown>>;
    expect(phaseRows).toHaveLength(2);

    const implementPhase = phaseRows.find((r) => r.phase_id === 'implement');
    expect(implementPhase).toMatchObject({
      phase_id: 'implement',
      total_input_tokens: null,
      total_output_tokens: null,
      total_reasoning_tokens: null,
      total_cached_tokens: null,
      invocation_count: 0,
      unknown_invocation_count: 1,
    });

    const planPhase = phaseRows.find((r) => r.phase_id === 'plan');
    expect(planPhase).toMatchObject({
      phase_id: 'plan',
      total_input_tokens: 1000,
      total_output_tokens: 500,
      total_reasoning_tokens: 100,
      total_cached_tokens: 200,
      invocation_count: 1,
      unknown_invocation_count: 0,
    });

    // Assert v_usage_by_run
    const runRows = db
      .prepare('SELECT * FROM v_usage_by_run WHERE run_uuid = ? ORDER BY phase_id ASC')
      .all('run-1') as Array<Record<string, unknown>>;
    expect(runRows).toHaveLength(2);
    expect(runRows.find((r) => r.phase_id === 'plan')).toMatchObject({
      total_input_tokens: 1000,
      total_output_tokens: 500,
      invocation_count: 1,
      unknown_invocation_count: 0,
    });
    expect(runRows.find((r) => r.phase_id === 'implement')).toMatchObject({
      total_input_tokens: null,
      total_output_tokens: null,
      invocation_count: 0,
      unknown_invocation_count: 1,
    });

    // Assert v_cost_by_phase
    const costRows = db
      .prepare('SELECT * FROM v_cost_by_phase ORDER BY phase_id ASC')
      .all() as Array<Record<string, unknown>>;
    expect(costRows).toHaveLength(2);

    const planCost = costRows.find((r) => r.phase_id === 'plan');
    expect(planCost?.estimated_cost_usd).toBeCloseTo(9.96, 6);
    expect(planCost?.invocation_count).toBe(1);
    expect(planCost?.unknown_invocation_count).toBe(0);

    const implementCost = costRows.find((r) => r.phase_id === 'implement');
    expect(implementCost?.estimated_cost_usd).toBeNull();
    expect(implementCost?.invocation_count).toBe(0);
    expect(implementCost?.unknown_invocation_count).toBe(1);

    db.close();
  });

  it('rejects measured rows without required tokens and unknown rows with token values', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    seedBaseRunAndInvocations(db);

    const insertUsage = db.prepare(
      `INSERT INTO agent_usage (
        invocation_id, run_uuid, phase_id, profile, provider, model,
        usage_status, input_tokens, output_tokens, reasoning_tokens, cached_tokens, recorded_at
      ) VALUES (
        @invocation_id, @run_uuid, @phase_id, @profile, @provider, @model,
        @usage_status, @input_tokens, @output_tokens, @reasoning_tokens, @cached_tokens, @recorded_at
      )`,
    );

    const baseRow = {
      invocation_id: 'inv-1',
      run_uuid: 'run-1',
      phase_id: 'plan',
      profile: 'opencode-frontier',
      provider: 'deepseek',
      model: 'deepseek-pro',
      recorded_at: '2026-01-01T00:01:00.000Z',
    };

    // Measured missing input_tokens
    expect(() =>
      insertUsage.run({
        ...baseRow,
        usage_status: 'measured',
        input_tokens: null,
        output_tokens: 100,
        reasoning_tokens: null,
        cached_tokens: null,
      }),
    ).toThrow();

    // Measured missing output_tokens
    expect(() =>
      insertUsage.run({
        ...baseRow,
        usage_status: 'measured',
        input_tokens: 100,
        output_tokens: null,
        reasoning_tokens: null,
        cached_tokens: null,
      }),
    ).toThrow();

    // Measured negative tokens
    expect(() =>
      insertUsage.run({
        ...baseRow,
        usage_status: 'measured',
        input_tokens: -1,
        output_tokens: 100,
        reasoning_tokens: null,
        cached_tokens: null,
      }),
    ).toThrow();
    expect(() =>
      insertUsage.run({
        ...baseRow,
        usage_status: 'measured',
        input_tokens: 100,
        output_tokens: -1,
        reasoning_tokens: null,
        cached_tokens: null,
      }),
    ).toThrow();
    expect(() =>
      insertUsage.run({
        ...baseRow,
        usage_status: 'measured',
        input_tokens: 100,
        output_tokens: 100,
        reasoning_tokens: -1,
        cached_tokens: null,
      }),
    ).toThrow();
    expect(() =>
      insertUsage.run({
        ...baseRow,
        usage_status: 'measured',
        input_tokens: 100,
        output_tokens: 100,
        reasoning_tokens: null,
        cached_tokens: -1,
      }),
    ).toThrow();

    // Unknown with token values
    expect(() =>
      insertUsage.run({
        ...baseRow,
        usage_status: 'unknown',
        input_tokens: 100,
        output_tokens: null,
        reasoning_tokens: null,
        cached_tokens: null,
      }),
    ).toThrow();
    expect(() =>
      insertUsage.run({
        ...baseRow,
        usage_status: 'unknown',
        input_tokens: null,
        output_tokens: 100,
        reasoning_tokens: null,
        cached_tokens: null,
      }),
    ).toThrow();
    expect(() =>
      insertUsage.run({
        ...baseRow,
        usage_status: 'unknown',
        input_tokens: null,
        output_tokens: null,
        reasoning_tokens: 10,
        cached_tokens: null,
      }),
    ).toThrow();
    expect(() =>
      insertUsage.run({
        ...baseRow,
        usage_status: 'unknown',
        input_tokens: null,
        output_tokens: null,
        reasoning_tokens: null,
        cached_tokens: 10,
      }),
    ).toThrow();

    // Invalid usage_status
    expect(() =>
      insertUsage.run({
        ...baseRow,
        usage_status: 'unspecified',
        input_tokens: null,
        output_tokens: null,
        reasoning_tokens: null,
        cached_tokens: null,
      }),
    ).toThrow();

    // Valid measured zero
    expect(() =>
      insertUsage.run({
        ...baseRow,
        usage_status: 'measured',
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        cached_tokens: 0,
      }),
    ).not.toThrow();

    db.close();
  });

  it('keeps unknown-only groups visible without adding them to measured totals or cost', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);

    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at)
       VALUES ('run-2', 'run-2', 2, 'issue', 'running', '[]', '2026-01-01T00:00:00.000Z')`,
    ).run();

    const insertInv = db.prepare(
      `INSERT INTO agent_invocations (
        id, run_uuid, phase_id, profile, runtime, provider, model,
        prompt_path, prompt_chars, stdout_path, stderr_path, started_at, ended_at,
        start_commit_sha, timeout_ms, contract_violations
      ) VALUES (
        @id, @runId, @phaseId, @profile, @runtime, @provider, @model,
        @promptPath, @promptChars, @stdoutPath, @stderrPath, @startedAt, @endedAt,
        @startCommitSha, @timeoutMs, @contractViolations
      )`,
    );

    // Group 1: phase-a has 1 measured + 1 unknown
    insertInv.run({
      id: 'inv-a1',
      runId: 'run-2',
      phaseId: 'phase-a',
      profile: 'p',
      runtime: 'opencode',
      provider: 'prov',
      model: 'mod',
      promptPath: '/tmp/p',
      promptChars: 10,
      stdoutPath: '/tmp/o',
      stderrPath: '/tmp/e',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:01:00.000Z',
      startCommitSha: 'a'.repeat(40),
      timeoutMs: 600000,
      contractViolations: '[]',
    });
    insertInv.run({
      id: 'inv-a2',
      runId: 'run-2',
      phaseId: 'phase-a',
      profile: 'p',
      runtime: 'opencode',
      provider: 'prov',
      model: 'mod',
      promptPath: '/tmp/p',
      promptChars: 10,
      stdoutPath: '/tmp/o',
      stderrPath: '/tmp/e',
      startedAt: '2026-01-01T00:02:00.000Z',
      endedAt: '2026-01-01T00:03:00.000Z',
      startCommitSha: 'a'.repeat(40),
      timeoutMs: 600000,
      contractViolations: '[]',
    });

    // Group 2: phase-b has 2 unknown
    insertInv.run({
      id: 'inv-b1',
      runId: 'run-2',
      phaseId: 'phase-b',
      profile: 'p',
      runtime: 'opencode',
      provider: 'prov',
      model: 'mod',
      promptPath: '/tmp/p',
      promptChars: 10,
      stdoutPath: '/tmp/o',
      stderrPath: '/tmp/e',
      startedAt: '2026-01-01T00:04:00.000Z',
      endedAt: '2026-01-01T00:05:00.000Z',
      startCommitSha: 'a'.repeat(40),
      timeoutMs: 600000,
      contractViolations: '[]',
    });
    insertInv.run({
      id: 'inv-b2',
      runId: 'run-2',
      phaseId: 'phase-b',
      profile: 'p',
      runtime: 'opencode',
      provider: 'prov',
      model: 'mod',
      promptPath: '/tmp/p',
      promptChars: 10,
      stdoutPath: '/tmp/o',
      stderrPath: '/tmp/e',
      startedAt: '2026-01-01T00:06:00.000Z',
      endedAt: '2026-01-01T00:07:00.000Z',
      startCommitSha: 'a'.repeat(40),
      timeoutMs: 600000,
      contractViolations: '[]',
    });

    db.prepare(
      `INSERT INTO model_prices (provider, model, effective_from, input_price_per_1k_tokens, output_price_per_1k_tokens)
       VALUES ('prov', 'mod', '2026-01-01', 10.0, 20.0)`,
    ).run();

    const insertUsage = db.prepare(
      `INSERT INTO agent_usage (
        invocation_id, run_uuid, phase_id, profile, provider, model,
        usage_status, input_tokens, output_tokens, reasoning_tokens, cached_tokens, recorded_at
      ) VALUES (
        @invocation_id, @run_uuid, @phase_id, @profile, @provider, @model,
        @usage_status, @input_tokens, @output_tokens, @reasoning_tokens, @cached_tokens, @recorded_at
      )`,
    );

    // phase-a: inv-a1 measured, inv-a2 unknown
    insertUsage.run({
      invocation_id: 'inv-a1',
      run_uuid: 'run-2',
      phase_id: 'phase-a',
      profile: 'p',
      provider: 'prov',
      model: 'mod',
      usage_status: 'measured',
      input_tokens: 500,
      output_tokens: 200,
      reasoning_tokens: null,
      cached_tokens: null,
      recorded_at: '2026-01-01T00:01:00.000Z',
    });
    insertUsage.run({
      invocation_id: 'inv-a2',
      run_uuid: 'run-2',
      phase_id: 'phase-a',
      profile: 'p',
      provider: 'prov',
      model: 'mod',
      usage_status: 'unknown',
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cached_tokens: null,
      recorded_at: '2026-01-01T00:03:00.000Z',
    });

    // phase-b: inv-b1 unknown, inv-b2 unknown
    insertUsage.run({
      invocation_id: 'inv-b1',
      run_uuid: 'run-2',
      phase_id: 'phase-b',
      profile: 'p',
      provider: 'prov',
      model: 'mod',
      usage_status: 'unknown',
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cached_tokens: null,
      recorded_at: '2026-01-01T00:05:00.000Z',
    });
    insertUsage.run({
      invocation_id: 'inv-b2',
      run_uuid: 'run-2',
      phase_id: 'phase-b',
      profile: 'p',
      provider: 'prov',
      model: 'mod',
      usage_status: 'unknown',
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cached_tokens: null,
      recorded_at: '2026-01-01T00:07:00.000Z',
    });

    // v_usage_by_phase checks
    const usageByPhase = db
      .prepare('SELECT * FROM v_usage_by_phase ORDER BY phase_id ASC')
      .all() as Array<Record<string, unknown>>;
    expect(usageByPhase).toHaveLength(2);

    const phaseA = usageByPhase.find((r) => r.phase_id === 'phase-a');
    expect(phaseA).toMatchObject({
      total_input_tokens: 500,
      total_output_tokens: 200,
      total_reasoning_tokens: 0,
      total_cached_tokens: 0,
      invocation_count: 1,
      unknown_invocation_count: 1,
    });

    const phaseB = usageByPhase.find((r) => r.phase_id === 'phase-b');
    expect(phaseB).toMatchObject({
      total_input_tokens: null,
      total_output_tokens: null,
      total_reasoning_tokens: null,
      total_cached_tokens: null,
      invocation_count: 0,
      unknown_invocation_count: 2,
    });

    // v_cost_by_phase checks
    const costByPhase = db
      .prepare('SELECT * FROM v_cost_by_phase ORDER BY phase_id ASC')
      .all() as Array<Record<string, unknown>>;
    expect(costByPhase).toHaveLength(2);

    const costA = costByPhase.find((r) => r.phase_id === 'phase-a');
    // 500 * 10/1000 + 200 * 20/1000 = 5 + 4 = 9.0
    expect(costA?.estimated_cost_usd).toBeCloseTo(9.0, 6);
    expect(costA?.invocation_count).toBe(1);
    expect(costA?.unknown_invocation_count).toBe(1);

    const costB = costByPhase.find((r) => r.phase_id === 'phase-b');
    expect(costB?.estimated_cost_usd).toBeNull();
    expect(costB?.total_input_tokens).toBeNull();
    expect(costB?.total_output_tokens).toBeNull();
    expect(costB?.invocation_count).toBe(0);
    expect(costB?.unknown_invocation_count).toBe(2);

    db.close();
  });

  it('preserves indexes, foreign keys, cascade deletion, and idempotent migration application', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);

    // Check indexes
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(indexes).toContain('idx_agent_usage_run');
    expect(indexes).toContain('idx_agent_usage_phase');
    expect(indexes).toContain('idx_agent_usage_model');

    // Check foreign keys
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at)
       VALUES ('run-fk', 'run-fk', 99, 'issue', 'running', '[]', '2026-01-01T00:00:00.000Z')`,
    ).run();

    db.prepare(
      `INSERT INTO agent_invocations (
        id, run_uuid, phase_id, profile, runtime, provider, model,
        prompt_path, prompt_chars, stdout_path, stderr_path, started_at, ended_at,
        start_commit_sha, timeout_ms, contract_violations
      ) VALUES (
        'inv-fk-1', 'run-fk', 'plan', 'p', 'opencode', 'prov', 'mod',
        '/tmp/p', 10, '/tmp/o', '/tmp/e', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z',
        '${'0'.repeat(40)}', 600000, '[]'
      )`,
    ).run();

    db.prepare(
      `INSERT INTO agent_usage (
        invocation_id, run_uuid, phase_id, profile, provider, model,
        usage_status, input_tokens, output_tokens, recorded_at
      ) VALUES (
        'inv-fk-1', 'run-fk', 'plan', 'p', 'prov', 'mod',
        'measured', 100, 100, '2026-01-01T00:01:00.000Z'
      )`,
    ).run();

    // Check cascade delete
    expect((db.prepare('SELECT COUNT(*) AS c FROM agent_usage').get() as { c: number }).c).toBe(1);

    db.prepare('DELETE FROM agent_invocations WHERE id = ?').run('inv-fk-1');

    expect((db.prepare('SELECT COUNT(*) AS c FROM agent_usage').get() as { c: number }).c).toBe(0);

    // Check idempotency
    expect(() => applyMigrations(db)).not.toThrow();

    db.close();
  });

  it('round-trips measured zero separately from unknown usage', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);

    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at)
       VALUES ('run-rt', 'run-rt', 1, 'issue', 'running', '[]', '2026-01-01T00:00:00.000Z')`,
    ).run();

    const insertInv = db.prepare(
      `INSERT INTO agent_invocations (
        id, run_uuid, phase_id, profile, runtime, provider, model,
        prompt_path, prompt_chars, stdout_path, stderr_path, started_at, ended_at,
        start_commit_sha, timeout_ms, contract_violations
      ) VALUES (
        @id, @runId, @phaseId, @profile, @runtime, @provider, @model,
        @promptPath, @promptChars, @stdoutPath, @stderrPath, @startedAt, @endedAt,
        @startCommitSha, @timeoutMs, @contractViolations
      )`,
    );

    insertInv.run({
      id: 'inv-zero',
      runId: 'run-rt',
      phaseId: 'plan',
      profile: 'p',
      runtime: 'opencode',
      provider: 'prov',
      model: 'mod',
      promptPath: '/tmp/p',
      promptChars: 10,
      stdoutPath: '/tmp/o',
      stderrPath: '/tmp/e',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:01:00.000Z',
      startCommitSha: 'a'.repeat(40),
      timeoutMs: 600000,
      contractViolations: '[]',
    });

    insertInv.run({
      id: 'inv-unk',
      runId: 'run-rt',
      phaseId: 'plan',
      profile: 'p',
      runtime: 'opencode',
      provider: 'prov',
      model: 'mod',
      promptPath: '/tmp/p',
      promptChars: 10,
      stdoutPath: '/tmp/o',
      stderrPath: '/tmp/e',
      startedAt: '2026-01-01T00:02:00.000Z',
      endedAt: '2026-01-01T00:03:00.000Z',
      startCommitSha: 'a'.repeat(40),
      timeoutMs: 600000,
      contractViolations: '[]',
    });

    const insertUsage = db.prepare(
      `INSERT INTO agent_usage (
        invocation_id, run_uuid, phase_id, profile, provider, model,
        usage_status, input_tokens, output_tokens, reasoning_tokens, cached_tokens, recorded_at
      ) VALUES (
        @invocation_id, @run_uuid, @phase_id, @profile, @provider, @model,
        @usage_status, @input_tokens, @output_tokens, @reasoning_tokens, @cached_tokens, @recorded_at
      )`,
    );

    insertUsage.run({
      invocation_id: 'inv-zero',
      run_uuid: 'run-rt',
      phase_id: 'plan',
      profile: 'p',
      provider: 'prov',
      model: 'mod',
      usage_status: 'measured',
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      cached_tokens: 0,
      recorded_at: '2026-01-01T00:01:00.000Z',
    });

    insertUsage.run({
      invocation_id: 'inv-unk',
      run_uuid: 'run-rt',
      phase_id: 'plan',
      profile: 'p',
      provider: 'prov',
      model: 'mod',
      usage_status: 'unknown',
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cached_tokens: null,
      recorded_at: '2026-01-01T00:03:00.000Z',
    });

    const rowZero = db
      .prepare('SELECT * FROM agent_usage WHERE invocation_id = ?')
      .get('inv-zero') as Record<string, unknown>;
    expect(rowZero.usage_status).toBe('measured');
    expect(rowZero.input_tokens).toBe(0);
    expect(rowZero.output_tokens).toBe(0);
    expect(rowZero.reasoning_tokens).toBe(0);
    expect(rowZero.cached_tokens).toBe(0);

    const rowUnk = db
      .prepare('SELECT * FROM agent_usage WHERE invocation_id = ?')
      .get('inv-unk') as Record<string, unknown>;
    expect(rowUnk.usage_status).toBe('unknown');
    expect(rowUnk.input_tokens).toBeNull();
    expect(rowUnk.output_tokens).toBeNull();
    expect(rowUnk.reasoning_tokens).toBeNull();
    expect(rowUnk.cached_tokens).toBeNull();

    db.close();
  });
});

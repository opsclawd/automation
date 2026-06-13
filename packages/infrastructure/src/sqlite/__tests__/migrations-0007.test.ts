import { describe, it, expect } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';

describe('migration 0007 agent-usage', () => {
  it('creates agent_usage, model_prices tables', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: { name: string }) => r.name);

    expect(tables).toContain('agent_usage');
    expect(tables).toContain('model_prices');
    db.close();
  });

  it('is idempotent', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();
    db.close();
  });

  it('creates expected indexes', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r: { name: string }) => r.name);

    expect(indexes).toContain('idx_agent_usage_run');
    expect(indexes).toContain('idx_agent_usage_phase');
    expect(indexes).toContain('idx_agent_usage_model');
    expect(indexes).toContain('idx_model_prices_lookup');
    db.close();
  });

  it('creates expected views', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);

    const views = db
      .prepare("SELECT name FROM sqlite_master WHERE type='view'")
      .all()
      .map((r: { name: string }) => r.name);

    expect(views).toContain('v_usage_by_phase');
    expect(views).toContain('v_usage_by_run');
    expect(views).toContain('v_cost_by_phase');
    db.close();
  });

  it('v_cost_by_phase accounts for cached tokens at cached price', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);

    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at)
      VALUES ('r1', 'run-1', 1, 'issue', 'running', '[]', '2026-01-01T00:00:00.000Z')`,
    ).run();

    db.prepare(
      "INSERT INTO agent_invocations (id, run_uuid, phase_id, profile, runtime, provider, model, prompt_path, prompt_chars, stdout_path, stderr_path, started_at, start_commit_sha, timeout_ms, contract_violations) VALUES ('inv-1', 'r1', 'plan', 'opencode-frontier', 'opencode', 'deepseek', 'deepseek-pro', '/tmp/p.md', 100, '/tmp/o', '/tmp/e', '2026-01-01T00:00:00.000Z', '" +
        'a'.repeat(40) +
        "', 600000, '[]')",
    ).run();

    db.prepare(
      `INSERT INTO model_prices (provider, model, effective_from, input_price_per_1k_tokens, output_price_per_1k_tokens, cached_input_price_per_1k_tokens)
      VALUES ('deepseek', 'deepseek-pro', '2026-01-01', 3.0, 15.0, 0.3)`,
    ).run();

    db.prepare(
      `INSERT INTO agent_usage (invocation_id, run_uuid, phase_id, profile, provider, model, input_tokens, output_tokens, cached_tokens, recorded_at)
      VALUES ('inv-1', 'r1', 'plan', 'opencode-frontier', 'deepseek', 'deepseek-pro', 1000, 500, 200, '2026-01-01T00:01:00.000Z')`,
    ).run();

    const row = db.prepare('SELECT * FROM v_cost_by_phase').get() as Record<string, unknown>;
    expect(row.total_input_tokens).toBe(1000);
    expect(row.total_output_tokens).toBe(500);
    expect(row.total_cached_tokens).toBe(200);
    // 800 non-cached * 3.0/1000 + 200 cached * 0.3/1000 + 500 * 15.0/1000 = 2.4 + 0.06 + 7.5 = 9.96
    expect(row.estimated_cost_usd).toBeCloseTo(9.96, 6);
    db.close();
  });

  it('v_cost_by_phase falls back to input_price when cached_input_price is null', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);

    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at)
      VALUES ('r1', 'run-1', 1, 'issue', 'running', '[]', '2026-01-01T00:00:00.000Z')`,
    ).run();

    db.prepare(
      "INSERT INTO agent_invocations (id, run_uuid, phase_id, profile, runtime, provider, model, prompt_path, prompt_chars, stdout_path, stderr_path, started_at, start_commit_sha, timeout_ms, contract_violations) VALUES ('inv-1', 'r1', 'plan', 'opencode-frontier', 'opencode', 'deepseek', 'deepseek-pro', '/tmp/p.md', 100, '/tmp/o', '/tmp/e', '2026-01-01T00:00:00.000Z', '" +
        'a'.repeat(40) +
        "', 600000, '[]')",
    ).run();

    db.prepare(
      `INSERT INTO model_prices (provider, model, effective_from, input_price_per_1k_tokens, output_price_per_1k_tokens)
      VALUES ('deepseek', 'deepseek-pro', '2026-01-01', 3.0, 15.0)`,
    ).run();

    db.prepare(
      `INSERT INTO agent_usage (invocation_id, run_uuid, phase_id, profile, provider, model, input_tokens, output_tokens, cached_tokens, recorded_at)
      VALUES ('inv-1', 'r1', 'plan', 'opencode-frontier', 'deepseek', 'deepseek-pro', 1000, 500, 200, '2026-01-01T00:01:00.000Z')`,
    ).run();

    const row = db.prepare('SELECT * FROM v_cost_by_phase').get() as Record<string, unknown>;
    // Falls back to input_price: (1000-200)*3/1000 + 200*3/1000 + 500*15/1000 = 2.4+0.6+7.5 = 10.5
    expect(row.estimated_cost_usd).toBeCloseTo(10.5, 6);
    db.close();
  });

  it('v_cost_by_phase handles no cached tokens', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);

    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at)
      VALUES ('r1', 'run-1', 1, 'issue', 'running', '[]', '2026-01-01T00:00:00.000Z')`,
    ).run();

    db.prepare(
      "INSERT INTO agent_invocations (id, run_uuid, phase_id, profile, runtime, provider, model, prompt_path, prompt_chars, stdout_path, stderr_path, started_at, start_commit_sha, timeout_ms, contract_violations) VALUES ('inv-1', 'r1', 'plan', 'opencode-frontier', 'opencode', 'deepseek', 'deepseek-pro', '/tmp/p.md', 100, '/tmp/o', '/tmp/e', '2026-01-01T00:00:00.000Z', '" +
        'a'.repeat(40) +
        "', 600000, '[]')",
    ).run();

    db.prepare(
      `INSERT INTO model_prices (provider, model, effective_from, input_price_per_1k_tokens, output_price_per_1k_tokens)
      VALUES ('deepseek', 'deepseek-pro', '2026-01-01', 3.0, 15.0)`,
    ).run();

    db.prepare(
      `INSERT INTO agent_usage (invocation_id, run_uuid, phase_id, profile, provider, model, input_tokens, output_tokens, recorded_at)
      VALUES ('inv-1', 'r1', 'plan', 'opencode-frontier', 'deepseek', 'deepseek-pro', 1000, 500, '2026-01-01T00:01:00.000Z')`,
    ).run();

    const row = db.prepare('SELECT * FROM v_cost_by_phase').get() as Record<string, unknown>;
    // 1000*3/1000 + 500*15/1000 = 3 + 7.5 = 10.5
    expect(row.estimated_cost_usd).toBeCloseTo(10.5, 6);
    expect(row.total_cached_tokens).toBe(0);
    db.close();
  });

  it('cascade deletes usage when invocation is deleted', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);

    // Seed a run (referenced by agent_usage)
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at)
      VALUES ('r1', 'run-1', 1, 'issue', 'running', '[]', '2026-01-01T00:00:00.000Z')`,
    ).run();

    // Seed an invocation (referenced by agent_usage)
    db.prepare(
      "INSERT INTO agent_invocations (id, run_uuid, phase_id, profile, runtime, provider, model, prompt_path, prompt_chars, stdout_path, stderr_path, started_at, start_commit_sha, timeout_ms, contract_violations) VALUES ('inv-1', 'r1', 'plan', 'opencode-frontier', 'opencode', 'deepseek', 'deepseek-pro', '/tmp/p.md', 100, '/tmp/o', '/tmp/e', '2026-01-01T00:00:00.000Z', '" +
        'a'.repeat(40) +
        "', 600000, '[]')",
    ).run();

    // Insert usage
    db.prepare(
      `INSERT INTO agent_usage (
      invocation_id, run_uuid, phase_id, profile, provider, model,
      input_tokens, output_tokens, recorded_at
    ) VALUES (
      'inv-1', 'r1', 'plan', 'opencode-frontier', 'deepseek', 'deepseek-pro',
      1234, 567, '2026-01-01T00:01:00.000Z'
    )`,
    ).run();

    expect(
      db.prepare('SELECT COUNT(*) AS c FROM agent_usage').get() as { c: number },
    ).toMatchObject({ c: 1 });

    db.prepare('DELETE FROM agent_invocations WHERE id = ?').run('inv-1');

    expect(
      db.prepare('SELECT COUNT(*) AS c FROM agent_usage').get() as { c: number },
    ).toMatchObject({ c: 0 });

    db.close();
  });
});

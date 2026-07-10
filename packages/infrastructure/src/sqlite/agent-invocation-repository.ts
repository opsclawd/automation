import type { Db } from './database.js';
import {
  AgentInvocationId,
  AgentProfileName,
  PhaseName,
  RunId,
  type AgentInvocation,
  type AgentInvocationOutcome,
  type AgentRuntimeKind,
} from '@ai-sdlc/domain';

// Canonical definition in @ai-sdlc/application (packages/application/src/ports/agent-invocation-port.ts).
// Duplicated here because infra cannot import from application per layer rules.
interface AgentInvocationUpdatePatch {
  endedAt?: Date;
  endCommitSha?: string;
  exitCode?: number;
  durationMs?: number;
  outcome?: AgentInvocation['outcome'];
  contractViolations?: string[];
  resultJsonPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
}

interface Row {
  id: string;
  run_uuid: string;
  phase_id: string;
  step_id: string | null;
  profile: string;
  runtime: string;
  provider: string;
  model: string;
  skill: string | null;
  prompt_path: string;
  prompt_chars: number;
  prompt_tokens_approx: number | null;
  stdout_path: string;
  stderr_path: string;
  started_at: string;
  ended_at: string | null;
  start_commit_sha: string;
  end_commit_sha: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  timeout_ms: number;
  outcome: string | null;
  contract_violations: string;
  result_json_path: string | null;
  fallback_of_invocation_id: string | null;
  prompt_hash: string | null;
  metadata: string | null;
}

function rowToInvocation(r: Row): AgentInvocation {
  return {
    id: AgentInvocationId(r.id),
    runId: RunId(r.run_uuid),
    phaseId: PhaseName(r.phase_id),
    ...(r.step_id !== null ? { stepId: r.step_id } : {}),
    profile: AgentProfileName(r.profile),
    runtime: r.runtime as AgentRuntimeKind,
    provider: r.provider,
    model: r.model,
    ...(r.skill !== null ? { skill: r.skill } : {}),
    promptPath: r.prompt_path,
    promptChars: r.prompt_chars,
    ...(r.prompt_tokens_approx !== null ? { promptTokensApprox: r.prompt_tokens_approx } : {}),
    stdoutPath: r.stdout_path,
    stderrPath: r.stderr_path,
    startedAt: new Date(r.started_at),
    ...(r.ended_at !== null ? { endedAt: new Date(r.ended_at) } : {}),
    startCommitSha: r.start_commit_sha,
    ...(r.end_commit_sha !== null ? { endCommitSha: r.end_commit_sha } : {}),
    ...(r.exit_code !== null ? { exitCode: r.exit_code } : {}),
    ...(r.duration_ms !== null ? { durationMs: r.duration_ms } : {}),
    timeoutMs: r.timeout_ms,
    ...(r.outcome !== null ? { outcome: r.outcome as AgentInvocationOutcome } : {}),
    contractViolations: JSON.parse(r.contract_violations) as string[],
    ...(r.result_json_path !== null ? { resultJsonPath: r.result_json_path } : {}),
    ...(r.fallback_of_invocation_id !== null
      ? { fallbackOfInvocationId: AgentInvocationId(r.fallback_of_invocation_id) }
      : {}),
    ...(r.prompt_hash !== null ? { promptHash: r.prompt_hash } : {}),
    ...(r.metadata !== null ? { metadata: JSON.parse(r.metadata) } : {}),
  };
}

/** Implements AgentInvocationPort (@ai-sdlc/application). */
export class AgentInvocationRepository {
  constructor(private readonly db: Db) {}

  insert(inv: AgentInvocation): void {
    this.db
      .prepare(
        `INSERT INTO agent_invocations (
          id, run_uuid, phase_id, step_id, profile, runtime, provider, model, skill,
          prompt_path, prompt_chars, prompt_tokens_approx,
          stdout_path, stderr_path,
          started_at, ended_at, start_commit_sha, end_commit_sha,
          exit_code, duration_ms, timeout_ms,
          outcome, contract_violations, result_json_path, fallback_of_invocation_id,
          prompt_hash, metadata
        ) VALUES (
          @id, @runId, @phaseId, @stepId, @profile, @runtime, @provider, @model, @skill,
          @promptPath, @promptChars, @promptTokensApprox,
          @stdoutPath, @stderrPath,
          @startedAt, @endedAt, @startCommitSha, @endCommitSha,
          @exitCode, @durationMs, @timeoutMs,
          @outcome, @contractViolations, @resultJsonPath, @fallbackOfInvocationId,
          @promptHash, @metadata
        )`,
      )
      .run({
        id: inv.id,
        runId: inv.runId,
        phaseId: inv.phaseId,
        stepId: inv.stepId ?? null,
        profile: inv.profile,
        runtime: inv.runtime,
        provider: inv.provider,
        model: inv.model,
        skill: inv.skill ?? null,
        promptPath: inv.promptPath,
        promptChars: inv.promptChars,
        promptTokensApprox: inv.promptTokensApprox ?? null,
        stdoutPath: inv.stdoutPath,
        stderrPath: inv.stderrPath,
        startedAt: inv.startedAt.toISOString(),
        endedAt: inv.endedAt?.toISOString() ?? null,
        startCommitSha: inv.startCommitSha,
        endCommitSha: inv.endCommitSha ?? null,
        exitCode: inv.exitCode ?? null,
        durationMs: inv.durationMs ?? null,
        timeoutMs: inv.timeoutMs,
        outcome: inv.outcome ?? null,
        contractViolations: JSON.stringify(inv.contractViolations ?? []),
        resultJsonPath: inv.resultJsonPath ?? null,
        fallbackOfInvocationId: inv.fallbackOfInvocationId ?? null,
        promptHash: inv.promptHash ?? null,
        metadata: inv.metadata ? JSON.stringify(inv.metadata) : null,
      });
  }

  update(id: AgentInvocationId, patch: AgentInvocationUpdatePatch): void {
    const setClauses: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.endedAt !== undefined) {
      setClauses.push('ended_at = @endedAt');
      params.endedAt = patch.endedAt.toISOString();
    }
    if (patch.endCommitSha !== undefined) {
      setClauses.push('end_commit_sha = @endCommitSha');
      params.endCommitSha = patch.endCommitSha;
    }
    if (patch.exitCode !== undefined) {
      setClauses.push('exit_code = @exitCode');
      params.exitCode = patch.exitCode;
    }
    if (patch.durationMs !== undefined) {
      setClauses.push('duration_ms = @durationMs');
      params.durationMs = patch.durationMs;
    }
    if (patch.outcome !== undefined) {
      setClauses.push('outcome = @outcome');
      params.outcome = patch.outcome;
    }
    if (patch.contractViolations !== undefined) {
      setClauses.push('contract_violations = @contractViolations');
      params.contractViolations = JSON.stringify(patch.contractViolations);
    }
    if (patch.resultJsonPath !== undefined) {
      setClauses.push('result_json_path = @resultJsonPath');
      params.resultJsonPath = patch.resultJsonPath;
    }
    if (patch.stdoutPath !== undefined) {
      setClauses.push('stdout_path = @stdoutPath');
      params.stdoutPath = patch.stdoutPath;
    }
    if (patch.stderrPath !== undefined) {
      setClauses.push('stderr_path = @stderrPath');
      params.stderrPath = patch.stderrPath;
    }
    if (setClauses.length === 0) return;
    const result = this.db
      .prepare(`UPDATE agent_invocations SET ${setClauses.join(', ')} WHERE id = @id`)
      .run(params);
    if (result.changes === 0) throw new Error(`AgentInvocation ${id} not found`);
  }

  findById(id: AgentInvocationId): AgentInvocation | undefined {
    const row = this.db.prepare(`SELECT * FROM agent_invocations WHERE id = ?`).get(id) as
      | Row
      | undefined;
    return row ? rowToInvocation(row) : undefined;
  }

  listByRun(runId: RunId): AgentInvocation[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_invocations WHERE run_uuid = ? ORDER BY started_at ASC`)
      .all(runId) as Row[];
    return rows.map(rowToInvocation);
  }

  listByRunAndPhase(runId: RunId, phaseId: PhaseName): AgentInvocation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_invocations WHERE run_uuid = ? AND phase_id = ? ORDER BY started_at ASC`,
      )
      .all(runId, phaseId) as Row[];
    return rows.map(rowToInvocation);
  }

  listByRuntime(runtime: AgentRuntimeKind): AgentInvocation[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_invocations WHERE runtime = ? ORDER BY started_at ASC`)
      .all(runtime) as Row[];
    return rows.map(rowToInvocation);
  }
}

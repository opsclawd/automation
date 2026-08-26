import type { Db } from './database.js';
import {
  AgentInvocationId,
  AgentProfileName,
  PhaseName,
  RunId,
  type AgentUsage,
} from '@ai-sdlc/domain';

interface Row {
  invocation_id: string;
  run_uuid: string;
  phase_id: string;
  profile: string;
  provider: string;
  model: string;
  usage_status: 'measured' | 'unknown';
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cached_tokens: number | null;
  recorded_at: string;
}

function rowToUsage(r: Row): AgentUsage {
  const identity = {
    invocationId: AgentInvocationId(r.invocation_id),
    runId: RunId(r.run_uuid),
    phaseId: PhaseName(r.phase_id),
    profile: AgentProfileName(r.profile),
    provider: r.provider,
    model: r.model,
    recordedAt: new Date(r.recorded_at),
  };

  if (r.usage_status === 'unknown') {
    return {
      ...identity,
      status: 'unknown',
    };
  }

  return {
    ...identity,
    status: 'measured',
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    ...(r.reasoning_tokens !== null ? { reasoningTokens: r.reasoning_tokens } : {}),
    ...(r.cached_tokens !== null ? { cachedTokens: r.cached_tokens } : {}),
  };
}

export class AgentUsageRepository {
  constructor(private readonly db: Db) {}

  insert(usage: AgentUsage): void {
    const isMeasured = usage.status === 'measured';
    this.db
      .prepare(
        `INSERT INTO agent_usage (
          invocation_id, run_uuid, phase_id, profile, provider, model,
          usage_status, input_tokens, output_tokens, reasoning_tokens, cached_tokens, recorded_at
        ) VALUES (
          @invocationId, @runId, @phaseId, @profile, @provider, @model,
          @usageStatus, @inputTokens, @outputTokens, @reasoningTokens, @cachedTokens, @recordedAt
        )`,
      )
      .run({
        invocationId: usage.invocationId,
        runId: usage.runId,
        phaseId: usage.phaseId,
        profile: usage.profile,
        provider: usage.provider,
        model: usage.model,
        usageStatus: usage.status,
        inputTokens: isMeasured ? usage.inputTokens : null,
        outputTokens: isMeasured ? usage.outputTokens : null,
        reasoningTokens: isMeasured ? (usage.reasoningTokens ?? null) : null,
        cachedTokens: isMeasured ? (usage.cachedTokens ?? null) : null,
        recordedAt: usage.recordedAt.toISOString(),
      });
  }

  findById(invocationId: AgentInvocationId): AgentUsage | undefined {
    const row = this.db
      .prepare('SELECT * FROM agent_usage WHERE invocation_id = ?')
      .get(invocationId) as Row | undefined;
    return row ? rowToUsage(row) : undefined;
  }

  listByRun(runId: RunId): AgentUsage[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_usage WHERE run_uuid = ? ORDER BY recorded_at ASC')
      .all(runId) as Row[];
    return rows.map(rowToUsage);
  }

  listByRunAndPhase(runId: RunId, phaseId: PhaseName): AgentUsage[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM agent_usage WHERE run_uuid = ? AND phase_id = ? ORDER BY recorded_at ASC',
      )
      .all(runId, phaseId) as Row[];
    return rows.map(rowToUsage);
  }
}

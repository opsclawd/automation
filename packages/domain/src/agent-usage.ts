import type { AgentInvocationId, PhaseName, RunId } from './ids.js';
import type { AgentProfileName } from './agent-types.js';

export interface AgentUsageIdentity {
  invocationId: AgentInvocationId;
  runId: RunId;
  phaseId: PhaseName;
  profile: AgentProfileName;
  provider: string;
  model: string;
  recordedAt: Date;
}

export interface MeasuredAgentUsage extends AgentUsageIdentity {
  status: 'measured';
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
}

export interface UnknownAgentUsage extends AgentUsageIdentity {
  status: 'unknown';
}

export type AgentUsage = MeasuredAgentUsage | UnknownAgentUsage;

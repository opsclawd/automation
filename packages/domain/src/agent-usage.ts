import type { AgentInvocationId, PhaseName, RunId } from './ids.js';
import type { AgentProfileName } from './agent-types.js';

export interface AgentUsage {
  invocationId: AgentInvocationId;
  runId: RunId;
  phaseId: PhaseName;
  profile: AgentProfileName;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  recordedAt: Date;
}

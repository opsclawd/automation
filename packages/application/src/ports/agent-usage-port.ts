import type { AgentInvocationId, PhaseName, RunId, AgentUsage } from '@ai-sdlc/domain';

export interface AgentUsagePort {
  insert(usage: AgentUsage): void;
  findById(invocationId: AgentInvocationId): AgentUsage | undefined;
  listByRun(runId: RunId): AgentUsage[];
  listByRunAndPhase(runId: RunId, phaseId: PhaseName): AgentUsage[];
}

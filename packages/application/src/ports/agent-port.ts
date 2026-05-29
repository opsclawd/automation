import type { AgentInvocationRequest, AgentInvocationResult } from './agent-invocation-types.js';

export interface AgentPort {
  invoke(input: AgentInvocationRequest): Promise<AgentInvocationResult>;
}

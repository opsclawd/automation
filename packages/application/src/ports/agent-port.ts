import type { AgentInvocationRequest, AgentInvocationResult } from '../agent/invocation.js';

export interface AgentPort {
  invoke(input: AgentInvocationRequest): Promise<AgentInvocationResult>;
}

import type { AgentPort } from '../ports/agent-port.js';
import type { AgentInvocationRequest, AgentInvocationResult } from '../agent/invocation.js';

export type FakeAgentResponse =
  | AgentInvocationResult
  | ((req: AgentInvocationRequest) => AgentInvocationResult);

export class FakeAgentPort implements AgentPort {
  readonly invocations: AgentInvocationRequest[] = [];
  private readonly queues: Map<string, FakeAgentResponse[]>;

  constructor(responses: Record<string, FakeAgentResponse[]> = {}) {
    this.queues = new Map();
    for (const [key, arr] of Object.entries(responses)) {
      if (arr !== undefined) {
        this.queues.set(key, [...arr]);
      }
    }
  }

  async invoke(input: AgentInvocationRequest): Promise<AgentInvocationResult> {
    this.invocations.push(input);
    const queue = this.queues.get(input.profile);
    if (!queue || queue.length === 0) {
      throw new Error(`No scripted response for profile "${input.profile}"`);
    }
    const response = queue.shift()!;
    if (typeof response === 'function') {
      return response(input);
    }
    return response;
  }
}

import type { AgentPort } from '../ports/agent-port.js';
import type {
  AgentInvocationRequest,
  AgentInvocationResult,
} from '../ports/agent-invocation-types.js';

export type FakeAgentResponse =
  | AgentInvocationResult
  | ((req: AgentInvocationRequest) => AgentInvocationResult | Promise<AgentInvocationResult>);

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
      return await response(input);
    }
    return response;
  }

  clearQueue(profile: string): void {
    this.queues.delete(profile);
  }

  enqueue(profile: string, response: FakeAgentResponse): void {
    const queue = this.queues.get(profile);
    if (queue) {
      queue.push(response);
    } else {
      this.queues.set(profile, [response]);
    }
  }
}

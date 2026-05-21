import { ConfigError, type AgentConfig } from '@ai-sdlc/shared';
import {
  type AgentPort,
  type AgentInvocationRequest,
  type AgentInvocationResult,
  type AgentRuntimeKind,
  AgentProfileName,
} from '@ai-sdlc/application';

export interface AgentRuntimeRegistryOptions {
  agent: AgentConfig;
  adapters: Partial<Record<AgentRuntimeKind, AgentPort>>;
}

export class AgentRuntimeRegistry {
  readonly agentPort: AgentPort;

  constructor(private readonly opts: AgentRuntimeRegistryOptions) {
    this.agentPort = {
      invoke: (req: AgentInvocationRequest): Promise<AgentInvocationResult> => {
        const profile = opts.agent.profiles[req.profile];
        if (!profile) throw new ConfigError(`unknown profile ${req.profile}`);
        const adapter = opts.adapters[profile.runtime];
        if (!adapter) throw new ConfigError(`no adapter registered for runtime ${profile.runtime}`);
        return adapter.invoke(req);
      },
    };
  }

  resolveProfileForPhase(phaseName: string): AgentProfileName {
    const entry = this.opts.agent.phaseProfiles[phaseName];
    if (!entry)
      throw new ConfigError(`unknown phase '${phaseName}' — no entry in agent.phaseProfiles`);
    return AgentProfileName(entry.profile);
  }
}

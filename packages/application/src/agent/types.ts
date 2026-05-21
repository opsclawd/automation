export type AgentRuntimeKind = 'opencode' | 'pi';

export type AgentProfileName = string & { readonly __brand: 'AgentProfileName' };
export function AgentProfileName(v: string): AgentProfileName {
  if (typeof v !== 'string' || v.trim().length === 0)
    throw new Error('AgentProfileName must be a non-empty string');
  return v as AgentProfileName;
}

export interface AgentProfile {
  runtime: AgentRuntimeKind;
  provider: string;
  model: string;
  contextLimitTokens?: number;
  promptBudgetTokens?: number;
  outputBudgetTokens?: number;
  timeoutMinutes: number;
}

export interface PhaseRoutingEntry {
  profile: AgentProfileName;
  fallbackProfile?: AgentProfileName;
}

export function isOpencodeProfile(profile: AgentProfile): boolean {
  return profile.runtime === 'opencode';
}

export function isPiProfile(profile: AgentProfile): boolean {
  return profile.runtime === 'pi';
}

export function validateAgentProfile(name: AgentProfileName, profile: AgentProfile): void {
  if (profile.timeoutMinutes <= 0) {
    throw new Error(
      `AgentProfile "${name}" has non-positive timeoutMinutes: ${profile.timeoutMinutes}`,
    );
  }
  if (profile.runtime === 'pi' && profile.contextLimitTokens === undefined) {
    throw new Error(`Pi AgentProfile "${name}" is missing required contextLimitTokens`);
  }
}

import { AgentProfileName, type AgentRuntimeKind } from '@ai-sdlc/domain';
export { AgentProfileName, type AgentRuntimeKind } from '@ai-sdlc/domain';

export interface AgentProfile {
  runtime: AgentRuntimeKind;
  provider: string;
  model: string;
  contextLimitTokens?: number;
  promptBudgetTokens?: number;
  outputBudgetTokens?: number;
  timeoutMinutes: number;
}

export function isOpencodeProfile(profile: AgentProfile): boolean {
  return profile.runtime === 'opencode';
}

export function isPiProfile(profile: AgentProfile): boolean {
  return profile.runtime === 'pi';
}

export function validateAgentProfile(name: AgentProfileName, profile: AgentProfile): void {
  if (!profile.provider || profile.provider.trim().length === 0) {
    throw new Error(`AgentProfile "${name}" has empty provider`);
  }
  if (!profile.model || profile.model.trim().length === 0) {
    throw new Error(`AgentProfile "${name}" has empty model`);
  }
  if (!Number.isFinite(profile.timeoutMinutes) || profile.timeoutMinutes <= 0) {
    throw new Error(
      `AgentProfile "${name}" has non-positive timeoutMinutes: ${profile.timeoutMinutes}`,
    );
  }
  if (
    profile.runtime === 'pi' &&
    (profile.contextLimitTokens === undefined ||
      !Number.isFinite(profile.contextLimitTokens) ||
      profile.contextLimitTokens <= 0)
  ) {
    throw new Error(
      `Pi AgentProfile "${name}" has invalid contextLimitTokens: ${profile.contextLimitTokens}`,
    );
  }
}

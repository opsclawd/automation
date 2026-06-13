export type AgentRuntimeKind = 'opencode' | 'pi' | 'antigravity' | 'claude-code' | 'codex';

export type AgentProfileName = string & { readonly __brand: 'AgentProfileName' };
export function AgentProfileName(v: string): AgentProfileName {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error('AgentProfileName must be a non-empty string');
  }
  return v as AgentProfileName;
}

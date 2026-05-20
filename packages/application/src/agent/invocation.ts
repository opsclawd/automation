// TEMPORARY INLINE: These types belong to M3-06 (agent/types.ts).
// Once M3-06 lands, delete these inlines and import from './types.js'.
export type AgentRuntimeKind = 'opencode' | 'pi';

export type AgentProfileName = string & { readonly __brand: 'AgentProfileName' };
export function AgentProfileName(v: string): AgentProfileName {
  if (typeof v !== 'string' || v.trim().length === 0)
    throw new Error('AgentProfileName must be a non-empty string');
  return v as AgentProfileName;
}
// END INLINE

export type AgentInvocationOutcome = 'success' | 'failed' | 'timeout' | 'contract_violation';

export interface AgentInvocationRequest {
  profile: AgentProfileName;
  promptPath: string;
  expectedArtifacts: string[];
  cwd: string;
  runId: string;
  repoId: string;
  workerId?: string;
  phaseId: string;
  stepId?: string;
}

export interface AgentInvocationResult {
  runtime: AgentRuntimeKind;
  provider: string;
  model: string;
  exitCode: number;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  resultJsonPath?: string;
  contractViolations: string[];
  outcome: AgentInvocationOutcome;
}

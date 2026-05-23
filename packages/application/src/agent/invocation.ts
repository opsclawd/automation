import { AgentProfileName, type AgentRuntimeKind } from './types.js';
export { AgentProfileName, type AgentRuntimeKind };

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
  startCommitSha: string;
  abortSignal?: AbortSignal;
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
  endCommitSha?: string;
}

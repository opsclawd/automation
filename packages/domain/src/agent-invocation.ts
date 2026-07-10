import type { AgentInvocationId, PhaseName, RunId } from './ids.js';
import type { AgentProfileName, AgentRuntimeKind } from './agent-types.js';

export type AgentInvocationOutcome = 'success' | 'failed' | 'timeout' | 'contract_violation';

export interface AgentInvocation {
  id: AgentInvocationId;
  runId: RunId;
  phaseId: PhaseName;
  stepId?: string;
  profile: AgentProfileName;
  runtime: AgentRuntimeKind;
  provider: string;
  model: string;
  skill?: string;
  promptPath: string;
  promptChars: number;
  promptTokensApprox?: number;
  stdoutPath: string;
  stderrPath: string;
  startedAt: Date;
  endedAt?: Date;
  startCommitSha: string;
  endCommitSha?: string;
  exitCode?: number;
  durationMs?: number;
  timeoutMs: number;
  outcome?: AgentInvocationOutcome;
  contractViolations?: string[];
  resultJsonPath?: string;
  fallbackOfInvocationId?: AgentInvocationId;
  promptHash?: string;
  metadata?: Record<string, unknown>;
}

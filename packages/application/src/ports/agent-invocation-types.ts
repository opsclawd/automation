import type { AgentInvocationId, AgentProfileName } from '@ai-sdlc/domain';
import { type AgentRuntimeKind } from '@ai-sdlc/domain';
export { AgentProfileName } from '@ai-sdlc/domain';
export type { AgentRuntimeKind };

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
  provider?: string;
  model?: string;
  promptBudgetTokens?: number;
  runtimeHints?: {
    contextLimitTokens?: number;
    outputBudgetTokens?: number;
  };
  fallbackOfInvocationId?: AgentInvocationId;
  fallbackReason?: string;
  timeoutMs?: number;
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
  stepId?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cachedTokens?: number;
  };
}

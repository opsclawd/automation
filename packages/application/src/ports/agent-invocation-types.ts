import type { AgentInvocationId, AgentProfileName } from '@ai-sdlc/domain';
import { type AgentRuntimeKind } from '@ai-sdlc/domain';
export { AgentProfileName } from '@ai-sdlc/domain';
export type { AgentRuntimeKind };

export type AgentInvocationOutcome = 'success' | 'failed' | 'timeout' | 'contract_violation';

export type StepAgentOutcome = AgentInvocationOutcome;

export interface AgentInvocationRequest {
  profile: AgentProfileName;
  promptPath: string;
  expectedArtifacts: string[];
  cwd: string;
  runId: string;
  repoId: string;
  workerId?: string | undefined;
  phaseId: string;
  stepId?: string | undefined;
  startCommitSha: string;
  abortSignal?: AbortSignal | undefined;
  runtime?: AgentRuntimeKind | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  promptBudgetTokens?: number | undefined;
  runtimeHints?: {
    contextLimitTokens?: number;
    outputBudgetTokens?: number;
  };
  fallbackOfInvocationId?: AgentInvocationId;
  fallbackReason?: string;
  timeoutMs?: number;
  sandboxMode?: 'read-only' | 'writable';
}

export interface AgentInvocationResult {
  runtime: AgentRuntimeKind;
  provider: string;
  model: string;
  exitCode: number;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  resultJsonPath?: string | undefined;
  contractViolations: string[];
  outcome: AgentInvocationOutcome;
  endCommitSha?: string | undefined;
  stepId?: string | undefined;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cachedTokens?: number;
  };
  remediatedArtifacts?: { src: string; artifact: string }[];
}

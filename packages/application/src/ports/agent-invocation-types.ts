import type { AgentInvocationId, AgentProfileName } from '@ai-sdlc/domain';
import { type AgentRuntimeKind } from '@ai-sdlc/domain';
export { AgentProfileName } from '@ai-sdlc/domain';
export type { AgentRuntimeKind };

export type AgentInvocationOutcome =
  | 'success'
  | 'failed'
  | 'timeout'
  | 'contract_violation'
  | 'duplicate_retry_suppressed';

export type StepAgentOutcome = AgentInvocationOutcome;

export type SemanticRetryClassification = 'semantic' | 'deterministic_gate';

export interface SemanticRetryIntent {
  normalizedPhase: string;
  classification: SemanticRetryClassification;
  relevantArtifactPaths: readonly string[];
}

export interface AgentInvocationRequest {
  profile: AgentProfileName;
  promptPath: string;
  expectedArtifacts: string[];
  /** Expected artifacts that must remain available as editable agent inputs. */
  preserveExpectedArtifacts?: string[];
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
  metadata?: Record<string, unknown>;
  retryIntent?: SemanticRetryIntent;
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
  remediatedArtifacts?: { src: string; artifact: string }[];
}

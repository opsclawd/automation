import type {
  AgentInvocation,
  AgentInvocationId,
  AgentRuntimeKind,
  PhaseName,
  RunId,
} from '@ai-sdlc/domain';

export interface AgentInvocationUpdatePatch {
  endedAt?: Date;
  endCommitSha?: string;
  exitCode?: number;
  durationMs?: number;
  outcome?: AgentInvocation['outcome'];
  contractViolations?: string[];
  resultJsonPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
}

export interface AgentInvocationPort {
  insert(invocation: AgentInvocation): void;
  update(id: AgentInvocationId, patch: AgentInvocationUpdatePatch): void;
  findById(id: AgentInvocationId): AgentInvocation | undefined;
  listByRun(runId: RunId): AgentInvocation[];
  listByRunAndPhase(runId: RunId, phaseId: PhaseName): AgentInvocation[];
  listByRuntime(runtime: AgentRuntimeKind): AgentInvocation[];
}

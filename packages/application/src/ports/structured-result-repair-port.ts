import type { AgentInvocationId } from '@ai-sdlc/domain';

export interface StructuredResultRepairPrimaryInvocation {
  id: AgentInvocationId;
  stdoutPath: string;
  stderrPath: string;
}

export interface StructuredResultRepairInput {
  runId: string;
  cwd: string;
  normalizedPhase: string;
  destination: string;
  schemaContractText: string;
  cappedRawArtifact: string;
  transcriptEvidence: string;
  expectedHead: string;
  classification: string;
  primaryInvocation: StructuredResultRepairPrimaryInvocation;
}

export type StructuredResultRepairOutcome = 'repaired' | 'not_attempted' | 'failed';

export interface StructuredResultRepairResult {
  outcome: StructuredResultRepairOutcome;
  repairInvocationId?: AgentInvocationId;
}

export interface StructuredResultRepairPort {
  repairStructuredResult(input: StructuredResultRepairInput): Promise<StructuredResultRepairResult>;
}

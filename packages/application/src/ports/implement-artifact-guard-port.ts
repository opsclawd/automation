import type { AgentInvocationOutcome } from './agent-invocation-types.js';

export interface ImplementArtifactGuardInput {
  runId: string;
  cwd: string;
  phaseId: string;
  stepIndex: number;
  expectedArtifacts: readonly string[];
  invocationEnd: {
    startCommitSha: string;
    endCommitSha?: string;
    durationMs: number;
    outcome: AgentInvocationOutcome;
  };
  invocationTranscript: {
    stdoutTail: string;
    stderrTail: string;
    resultJsonPath?: string;
  };
}

export interface SynthesizedArtifact {
  artifact: string;
  reason: 'no_op_reverification_done_declared' | 'already_present' | 'policy_not_satisfied';
}

export interface ImplementArtifactGuardPort {
  /**
   * If `expectedArtifacts` is missing the contract-required file but the
   * agent declared DONE and the git invariant confirms no work was done,
   * synthesize a minimal `implementation-log.md` from verifiable state.
   *
   * MUST be idempotent: invoking twice yields the same content and writes
   * nothing the second time. MUST NOT touch any file the agent has
   * already written.
   */
  synthesizeMissingArtifactsIfDoneDeclared(
    input: ImplementArtifactGuardInput,
  ): Promise<{ synthesized: SynthesizedArtifact[] }>;
}

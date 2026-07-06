import type { AgentInvocationId } from '@ai-sdlc/domain';

export interface SynthesizeFromTranscriptInput {
  runId: string;
  cwd: string;
  phaseId: string;
  stepIndex: number;
  // The PRIMARY invocation whose artifact is missing. The synthesis row's
  // fallbackOfInvocationId points back to this id.
  primaryInvocation: {
    id: AgentInvocationId;
    stdoutPath: string;
    stderrPath: string;
  };
  // The single missing artifact (D3.c — exactly one allowed).
  missingArtifact: string;
  // Git state of the primary invocation.
  startCommitSha: string;
  endCommitSha: string;
  // Exit code of the primary invocation (D3.2 — must be 0).
  primaryExitCode: number;
  // Whether the worktree has uncommitted changes after the primary.
  workingTreeDirty: boolean;
}

export type SynthesizeFromTranscriptOutcome =
  | 'no_policy_match'
  | 'synthesized'
  | 'synthesis_failed';

export interface SynthesizeFromTranscriptResult {
  outcome: SynthesizeFromTranscriptOutcome;
  synthesisInvocationId?: AgentInvocationId;
  tailBytes?: number;
}

export interface SynthesizeFromTranscriptPort {
  /**
   * If the primary invocation ended with contract_violation for
   * MISSING_REQUIRED_ARTIFACT on a prose-eligible artifact AND the transcript
   * tail looks like a structured summary AND git state shows real work was
   * committed, call the result-writer profile to lift the prose from the tail
   * into the missing file. MUST be idempotent (re-running with the file
   * already in place is a no-op).
   */
  synthesizeFromTranscript(
    input: SynthesizeFromTranscriptInput,
  ): Promise<SynthesizeFromTranscriptResult>;
}

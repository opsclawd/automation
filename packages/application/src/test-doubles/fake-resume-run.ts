import type { RunId, WorkerId, JobId, ResumeDisposition, PinnedRuntime } from '@ai-sdlc/domain';
import type { ResumeRunUseCase } from '../use-cases.js';
import type { ResumeTransitionState } from '../resume-run.js';

export class FakeResumeRun implements ResumeRunUseCase {
  calls: Array<{
    runId: RunId;
    fromPhase?: string;
    workerId: WorkerId;
    attempt?: number;
    resumeDisposition?: ResumeDisposition;
    pinnedRuntime?: PinnedRuntime;
  }> = [];
  async execute(input: {
    runId: RunId;
    fromPhase?: string;
    workerId: WorkerId;
    attempt?: number;
    resumeDisposition?: ResumeDisposition;
    pinnedRuntime?: PinnedRuntime;
  }): Promise<{ jobId: JobId; jobStatus: 'queued' }> {
    this.calls.push(input);
    return {
      jobId: `resume-${input.runId}-fake` as JobId,
      jobStatus: 'queued',
    };
  }

  async transition(input: {
    runId: RunId;
    fromPhase?: string;
    workerId: WorkerId;
    attempt?: number;
    resumeDisposition?: ResumeDisposition;
    pinnedRuntime?: PinnedRuntime;
  }): Promise<ResumeTransitionState> {
    this.calls.push(input);
    return {
      savedStatus: 'failed',
      savedCompletedAt: null,
      savedFailureReason: null,
      savedCurrentPhase: null,
      savedPinnedRuntime: null,
      savedCompletedPhases: [],
      savedSkippedPhases: [],
      savedSteps: [],
      effectiveDisposition: input.resumeDisposition ?? 'reset_to_baseline',
    };
  }
}

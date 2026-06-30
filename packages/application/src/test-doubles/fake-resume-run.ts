import type { RunId, WorkerId, JobId } from '@ai-sdlc/domain';
import type { ResumeRunUseCase } from '../use-cases.js';

export class FakeResumeRun implements ResumeRunUseCase {
  calls: Array<{ runId: RunId; fromPhase?: string; workerId: WorkerId; attempt?: number }> = [];
  async execute(input: {
    runId: RunId;
    fromPhase?: string;
    workerId: WorkerId;
    attempt?: number;
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
  }) {
    this.calls.push(input);
  }
}

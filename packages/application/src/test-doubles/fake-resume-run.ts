import type { RunId, WorkerId } from '@ai-sdlc/domain';
import type { ResumeRunUseCase } from '../use-cases.js';

export class FakeResumeRun implements ResumeRunUseCase {
  calls: Array<{ runId: RunId; fromPhase?: string; workerId: WorkerId; attempt?: number }> = [];
  async execute(input: { runId: RunId; fromPhase?: string; workerId: WorkerId; attempt?: number }) {
    this.calls.push(input);
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

import type { RunId, WorkerId } from '@ai-sdlc/domain';
import type { RunRepositoryPort, PhaseRepositoryPort } from './ports.js';
import type { RetryFailedPhaseUseCase, ResumeRunUseCase } from './use-cases.js';

export interface RetryFailedPhaseDeps {
  runRepository: RunRepositoryPort;
  phaseRepo: PhaseRepositoryPort;
  resumeRun: ResumeRunUseCase;
}

export class RetryFailedPhase implements RetryFailedPhaseUseCase {
  constructor(private readonly deps: RetryFailedPhaseDeps) {}

  async execute(input: { runId: RunId; workerId: WorkerId }): Promise<void> {
    const run = this.deps.runRepository.findByUuid(input.runId);
    if (!run) throw new Error(`No run found for ${input.runId}`);
    if (!run.currentPhase) {
      throw new Error(`Cannot retry phase for run ${input.runId}: no current phase to retry`);
    }
    const phases = this.deps.phaseRepo.listByRun(input.runId);
    const previousAttempts = phases.filter((p) => p.name === run.currentPhase).length;
    return this.deps.resumeRun.execute({
      runId: input.runId,
      fromPhase: run.currentPhase,
      workerId: input.workerId,
      attempt: previousAttempts + 1,
    });
  }
}

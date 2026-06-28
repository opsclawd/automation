import type { Phase, RunId, WorkerId } from '@ai-sdlc/domain';
import type { RunRepositoryPort, PhaseRepositoryPort } from './ports.js';
import type { RetryFailedPhaseUseCase } from './use-cases.js';
import type { ResumeRun } from './resume-run.js';

export interface RetryFailedPhaseDeps {
  runRepository: RunRepositoryPort;
  phaseRepo: PhaseRepositoryPort;
  resumeRun: Pick<ResumeRun, 'transition'>;
}

export class RetryFailedPhase implements RetryFailedPhaseUseCase {
  constructor(private readonly deps: RetryFailedPhaseDeps) {}

  async execute(input: { runId: RunId; workerId: WorkerId }): Promise<void> {
    const run = this.deps.runRepository.findByUuid(input.runId);
    if (!run) throw new Error(`No run found for ${input.runId}`);
    if (run.status !== 'failed') {
      throw new Error(`Cannot retry phase for run ${input.runId}: status is '${run.status}'`);
    }
    const phases = this.deps.phaseRepo.listByRun(input.runId);
    const phaseName = (run.currentPhase || null) ?? latestFailedPhaseName(phases);
    if (!phaseName) {
      throw new Error(`Cannot retry phase for run ${input.runId}: no current phase to retry`);
    }
    const failedPhaseAttempts = phases
      .filter((p) => p.name === phaseName && p.status === 'failed')
      .map((p) => p.attempt ?? 0);
    const maxAttempt = failedPhaseAttempts.length > 0 ? Math.max(...failedPhaseAttempts) : 0;
    await this.deps.resumeRun.transition({
      runId: input.runId,
      fromPhase: phaseName,
      workerId: input.workerId,
      attempt: maxAttempt + 1,
    });
  }
}

function latestFailedPhaseName(phases: Phase[]): string | undefined {
  const failed = phases.filter((p) => p.status === 'failed');
  if (failed.length === 0) return undefined;
  failed.sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0));
  return failed[0]!.name;
}

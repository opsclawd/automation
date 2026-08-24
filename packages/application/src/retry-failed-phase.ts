import type { Phase, RunId, WorkerId } from '@ai-sdlc/domain';
import type { RunRepositoryPort, PhaseRepositoryPort } from './ports.js';
import type { RetryFailedPhaseUseCase } from './use-cases.js';
import type { ResumeRun, ResumeTransitionState } from './resume-run.js';

export interface RetryFailedPhaseDeps {
  runRepository: RunRepositoryPort;
  phaseRepo: PhaseRepositoryPort;
  resumeRun: ResumeRun;
}

export class RetryFailedPhase implements RetryFailedPhaseUseCase {
  constructor(private readonly deps: RetryFailedPhaseDeps) {}

  async execute(input: { runId: RunId; workerId: WorkerId }): Promise<ResumeTransitionState> {
    const run = this.deps.runRepository.findByUuid(input.runId);
    if (!run) throw new Error(`No run found for ${input.runId}`);
    if (
      run.status !== 'failed' &&
      run.status !== 'blocked' &&
      run.status !== 'needs_human_review' &&
      run.status !== 'cancelled'
    ) {
      throw new Error(
        `Cannot retry phase for run ${input.runId}: status is '${run.status}', expected 'failed', 'blocked', 'needs_human_review', or 'cancelled'`,
      );
    }
    const phases = this.deps.phaseRepo.listByRun(input.runId);
    const phaseName = (run.currentPhase || null) ?? latestRecoverablePhaseName(phases);
    if (!phaseName) {
      throw new Error(`Cannot retry phase for run ${input.runId}: no current phase to retry`);
    }
    const recoverablePhaseAttempts = phases
      .filter(
        (p) =>
          p.name === phaseName &&
          (p.status === 'failed' ||
            p.status === 'blocked' ||
            p.status === 'needs_human_review' ||
            p.status === 'running'),
      )
      .map((p) => p.attempt ?? 0);
    const maxAttempt =
      recoverablePhaseAttempts.length > 0 ? Math.max(...recoverablePhaseAttempts) : 0;
    return await this.deps.resumeRun.transition({
      runId: input.runId,
      fromPhase: phaseName,
      workerId: input.workerId,
      attempt: maxAttempt + 1,
      resumeDisposition: 'reset_to_baseline',
    });
  }
}

function latestRecoverablePhaseName(phases: Phase[]): string | undefined {
  const recoverable = phases
    .filter(
      (p) =>
        p.status === 'failed' ||
        p.status === 'blocked' ||
        p.status === 'needs_human_review' ||
        p.status === 'running',
    )
    .slice()
    .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0));
  return recoverable[0]?.name;
}

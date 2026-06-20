import { canResume, resumeRun, createJob } from '@ai-sdlc/domain';
import { IssueNumber } from '@ai-sdlc/domain';
import type { RunId, WorkerId, RepositoryId, JobId, Step, RunStatus } from '@ai-sdlc/domain';
import type {
  RunRepositoryPort,
  RepositoryPort,
  WorkerLeasePort,
  JobQueuePort,
  PhaseRepositoryPort,
  StepRepositoryPort,
} from './ports.js';
import type { ResumeRunUseCase } from './use-cases.js';

const LEASE_TTL_MS = 120_000;

export interface ResumeRunDeps {
  runRepository: RunRepositoryPort;
  repos: RepositoryPort;
  leases: WorkerLeasePort;
  queue: JobQueuePort;
  stepRepo: StepRepositoryPort;
  phaseRepo: PhaseRepositoryPort;
  findRepoId: (runId: RunId) => RepositoryId;
  now?: () => Date;
}

export class ResumeRun implements ResumeRunUseCase {
  constructor(private readonly deps: ResumeRunDeps) {}

  async execute(input: {
    runId: RunId;
    fromPhase?: string;
    workerId: WorkerId;
    attempt?: number;
  }): Promise<void> {
    const now = this.deps.now ?? (() => new Date());
    const run = this.deps.runRepository.findByUuid(input.runId);
    if (!run) throw new Error(`No run found for ${input.runId}`);
    if (!canResume(run)) {
      throw new Error(`Cannot resume run ${input.runId}: status is '${run.status}'`);
    }

    const repoId = this.deps.findRepoId(input.runId);
    const repo = this.deps.repos.findById(repoId);
    if (!repo) throw new Error(`No repo found for run ${input.runId}`);
    if (!repo.enabled) {
      throw new Error(`Cannot resume run ${input.runId}: repo '${repo.fullName}' is disabled`);
    }

    this.deps.leases.acquire({
      repoId: repo.id,
      workerId: input.workerId,
      runId: input.runId,
      now: now(),
      ttlMs: LEASE_TTL_MS,
    });

    try {
      const reactivated = resumeRun(run, input.fromPhase);
      const job = createJob({
        id: `resume-${input.runId}-${now().getTime()}` as JobId,
        runId: input.runId,
        repoId: repo.id,
        issueNumber: IssueNumber(run.issueNumber),
        priority: 10,
        createdAt: now(),
      });

      if (input.fromPhase) {
        const steps = this.deps.stepRepo
          .listForRun(input.runId)
          .filter((s: Step) => s.phaseId != null && s.phaseId === input.fromPhase);
        for (const step of steps) {
          const { startedAt: _sa, completedAt: _ca, ...stepFields } = step;
          this.deps.stepRepo.upsert({ ...stepFields, status: 'pending' });
        }
        const phase = {
          id: input.fromPhase,
          runUuid: input.runId,
          name: input.fromPhase,
          status: 'pending' as const,
          attempt: input.attempt ?? 1,
        };
        this.deps.phaseRepo.insert(phase);
      }

      const updated = this.deps.runRepository.atomicUpdateByUuid(
        input.runId,
        {
          status: reactivated.status,
          currentPhase: reactivated.currentPhase ?? null,
          completedPhases: reactivated.completedPhases,
          skippedPhases: reactivated.skippedPhases,
        },
        'failed' as RunStatus,
      );
      if (!updated) {
        throw new Error(`Run ${input.runId} status could not be updated (concurrent modification)`);
      }

      this.deps.queue.enqueue({ job });
    } catch (err) {
      this.deps.leases.release(repo.id, input.workerId);
      throw err;
    }
  }
}

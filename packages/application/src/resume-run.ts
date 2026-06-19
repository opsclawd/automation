import { canResume, resumeRun, createJob } from '@ai-sdlc/domain';
import type { RunId, WorkerId, IssueNumber, RepositoryId, JobId, Step } from '@ai-sdlc/domain';
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
  now?: () => Date;
}

export class ResumeRun implements ResumeRunUseCase {
  constructor(private readonly deps: ResumeRunDeps) {}

  async execute(input: { runId: RunId; fromPhase?: string; workerId: WorkerId }): Promise<void> {
    const now = this.deps.now ?? (() => new Date());
    const run = this.deps.runRepository.findByUuid(input.runId);
    if (!run) throw new Error(`No run found for ${input.runId}`);
    if (!canResume(run)) {
      throw new Error(`Cannot resume run ${input.runId}: status is '${run.status}'`);
    }

    const repo =
      this.deps.repos.findById(input.runId as unknown as RepositoryId) ??
      (() => {
        throw new Error(`No repo found for run ${input.runId}`);
      })();

    this.deps.leases.acquire({
      repoId: repo.id,
      workerId: input.workerId,
      runId: input.runId,
      now: now(),
      ttlMs: LEASE_TTL_MS,
    });

    if (input.fromPhase) {
      const steps = this.deps.stepRepo
        .listForRun(input.runId)
        .filter((s: Step) => s.phaseId === input.fromPhase);
      for (const step of steps) {
        const { startedAt: _sa, completedAt: _ca, ...stepFields } = step;
        this.deps.stepRepo.upsert({ ...stepFields, status: 'pending' });
      }
      const phase = {
        id: input.fromPhase,
        runUuid: input.runId,
        name: input.fromPhase,
        status: 'pending' as const,
        attempt: 1,
      };
      this.deps.phaseRepo.insert(phase);
    }

    const reactivated = resumeRun(run, input.fromPhase);
    this.deps.runRepository.update(input.runId, {
      status: reactivated.status,
      currentPhase: reactivated.currentPhase ?? null,
    });

    const job = createJob({
      id: `resume-${input.runId}-${Date.now()}` as JobId,
      runId: input.runId,
      repoId: repo.id,
      issueNumber: run.issueNumber as IssueNumber,
      priority: 10,
      createdAt: now(),
    });
    this.deps.queue.enqueue({ job });
  }
}

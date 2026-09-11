import { randomUUID } from 'node:crypto';
import {
  createReleaseBatch,
  admitItem,
  createRun,
  createJob,
  type ReleaseBatch,
  ReleaseBatchId,
  RepositoryId,
  RunId,
  JobId,
  IssueNumber,
  type ExecutionPolicy,
  type Repository,
  RepositoryNotApprovedError,
  RepositoryValidationError,
  ReleaseBatchStateError,
} from '@ai-sdlc/domain';
import { newRunId } from '@ai-sdlc/shared';
import type {
  ReleaseBatchRepositoryPort,
  RunRepositoryPort,
  JobQueuePort,
  GitPort,
  GitHubPort,
  EventBusPort,
  EventRepositoryPort,
} from './ports.js';

export class ReleaseBatchValidationError extends ReleaseBatchStateError {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseBatchValidationError';
    Object.setPrototypeOf(this, ReleaseBatchValidationError.prototype);
  }
}

export class ReleaseBatchPreflightError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReleaseBatchPreflightError';
    Object.setPrototypeOf(this, ReleaseBatchPreflightError.prototype);
  }
}

export class ReleaseBranchConflictError extends ReleaseBatchPreflightError {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseBranchConflictError';
    Object.setPrototypeOf(this, ReleaseBranchConflictError.prototype);
  }
}

import type { EventRepositoryFactory } from './start-issue-run.js';

export interface StartReleaseBatchDeps {
  releaseBatchRepository: ReleaseBatchRepositoryPort;
  runRepository: RunRepositoryPort;
  jobQueue: JobQueuePort;
  repositoryPort: {
    findById(id: RepositoryId): Repository | undefined;
    listEnabled(): Repository[];
  };
  git: GitPort;
  github: GitHubPort;
  eventBus: EventBusPort;
  eventRepository?: EventRepositoryPort | EventRepositoryFactory | undefined;
  executionPolicy?: ExecutionPolicy | undefined;
  now?: (() => Date) | undefined;
  logger?:
    | {
        info?: ((msg: string) => void) | undefined;
        warn?: ((msg: string) => void) | undefined;
        error?: ((msg: string, err?: unknown) => void) | undefined;
      }
    | undefined;
}

export interface StartReleaseBatchInput {
  repoId?: RepositoryId | undefined;
  issueNumbers: number[];
  sourceBranch?: string | undefined;
  releaseBranch?: string | undefined;
  batchId?: ReleaseBatchId | undefined;
  executionPolicy?: ExecutionPolicy | undefined;
}

export interface StartReleaseBatchOutput {
  batchId: ReleaseBatchId;
  releaseBranch: string;
  sourceBranch: string;
  sourceStartSha: string;
  runUuid: string;
  runDisplayId: string;
  jobId: JobId;
  batch: ReleaseBatch;
}

function formatUtcDate(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function isValidGitBranchName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed !== name) return false;
  // Cannot start or end with slash, cannot end with .lock
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.lock')) return false;
  // Cannot contain '..' or '//'
  if (name.includes('..') || name.includes('//')) return false;
  // Cannot contain control chars, space, ~, ^, :, ?, *, [, \, @{
  if (/[\s~^:?*\[\\@{]/.test(name)) return false;
  // Cannot end with dot
  if (name.endsWith('.')) return false;
  return true;
}

export function generateDeterministicReleaseBranch(date: Date, identifier: string): string {
  const dateStr = formatUtcDate(date);
  return `release/${dateStr}-${identifier}`;
}

export class StartReleaseBatch {
  constructor(private readonly deps: StartReleaseBatchDeps) {}

  async execute(input: StartReleaseBatchInput): Promise<StartReleaseBatchOutput> {
    const nowFn = this.deps.now ?? (() => new Date());
    const startedAt = nowFn();
    const logger = this.deps.logger ?? {
      info: () => {},
      warn: () => {},
      error: (m, e) => console.error(m, e),
    };

    // 1. Validate issueNumbers input
    if (
      !input.issueNumbers ||
      !Array.isArray(input.issueNumbers) ||
      input.issueNumbers.length === 0
    ) {
      throw new ReleaseBatchValidationError(
        'issueNumbers must be a non-empty array of positive integers',
      );
    }

    const seenIssues = new Set<number>();
    for (const issue of input.issueNumbers) {
      if (!Number.isInteger(issue) || issue <= 0) {
        throw new ReleaseBatchValidationError(
          `issueNumber must be a positive integer, got ${issue}`,
        );
      }
      if (seenIssues.has(issue)) {
        throw new ReleaseBatchValidationError(`duplicate issue number ${issue} in issueNumbers`);
      }
      seenIssues.add(issue);
    }

    // 2. Resolve target repository
    let repoId: RepositoryId;
    if (input.repoId) {
      repoId = input.repoId;
    } else {
      const enabled = this.deps.repositoryPort.listEnabled();
      const firstEnabled = enabled[0];
      if (enabled.length === 1 && firstEnabled) {
        repoId = firstEnabled.id;
      } else {
        throw new RepositoryValidationError(
          `repoId is required when more than one repository is enabled (found ${enabled.length})`,
          'StartReleaseBatch.input.repoId',
        );
      }
    }

    // 3. Verify repository is approved, enabled, and healthy
    const repo = this.deps.repositoryPort.findById(repoId);
    if (!repo) {
      throw new RepositoryNotApprovedError(repoId);
    }
    if (!repo.enabled) {
      throw new RepositoryNotApprovedError(repoId, `Repository '${repo.fullName}' is disabled`);
    }
    if (repo.healthStatus === 'degraded' || repo.healthStatus === 'unreachable') {
      throw new RepositoryNotApprovedError(
        repoId,
        `Repository '${repo.fullName}' is degraded or unreachable`,
      );
    }

    const repoRoot = repo.localBasePath;
    const sourceBranch = input.sourceBranch ?? repo.defaultBranch ?? 'main';

    // 4. Verify GitHub auth & write capabilities
    if (this.deps.github.verifyCapabilities) {
      try {
        await this.deps.github.verifyCapabilities(repo.fullName);
      } catch (err) {
        throw new ReleaseBatchPreflightError(
          `GitHub capability preflight failed for repository ${repo.fullName}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    }

    // 5. Verify every issue exists in target repository
    for (const issueNumber of input.issueNumbers) {
      try {
        await this.deps.github.getIssue(repo.fullName, issueNumber);
      } catch (err) {
        throw new ReleaseBatchPreflightError(
          `Preflight verification failed: issue #${issueNumber} not found or inaccessible in repository ${repo.fullName}`,
          { cause: err },
        );
      }
    }

    // 6. Fetch source branch and resolve exact origin/<sourceBranch> SHA
    try {
      await this.deps.git.fetch(repoRoot, 'origin', sourceBranch);
    } catch (err) {
      throw new ReleaseBatchPreflightError(
        `Preflight verification failed: remote source branch '${sourceBranch}' not found on origin of ${repoRoot}`,
        { cause: err },
      );
    }

    const sourceStartSha = await this.deps.git.resolveRef(repoRoot, `origin/${sourceBranch}`);
    if (!sourceStartSha) {
      throw new ReleaseBatchPreflightError(
        `Preflight verification failed: could not resolve remote ref 'origin/${sourceBranch}' in ${repoRoot}`,
      );
    }

    // 7. Resolve and validate release branch name
    let releaseBranch: string;
    if (input.releaseBranch !== undefined) {
      if (!isValidGitBranchName(input.releaseBranch)) {
        throw new ReleaseBatchValidationError(
          `Invalid release branch name: '${input.releaseBranch}'`,
        );
      }
      releaseBranch = input.releaseBranch;
    } else {
      const identifier = input.batchId ?? `batch-${input.issueNumbers.join('-')}`;
      releaseBranch = generateDeterministicReleaseBranch(startedAt, identifier);
    }

    // 8. Verify remote release branch ref does not unexpectedly point elsewhere
    const existingRemoteSha = await this.deps.git.remoteRef({
      cwd: repoRoot,
      remote: 'origin',
      ref: releaseBranch,
    });

    if (existingRemoteSha !== undefined && existingRemoteSha !== sourceStartSha) {
      throw new ReleaseBranchConflictError(
        `Release branch '${releaseBranch}' already exists on remote and points to ${existingRemoteSha}, expected source SHA ${sourceStartSha}`,
      );
    }

    // 9. Check existing ReleaseBatch in database for this release branch
    const existingDbBatch = this.deps.releaseBatchRepository.findByReleaseBranch(
      repoId,
      releaseBranch,
    );

    if (existingDbBatch) {
      if (existingDbBatch.sourceStartSha !== sourceStartSha) {
        throw new ReleaseBranchConflictError(
          `Release batch ${existingDbBatch.id} already exists for branch '${releaseBranch}' with source SHA ${existingDbBatch.sourceStartSha}, conflicting with expected ${sourceStartSha}`,
        );
      }
      // Check items compatibility
      if (existingDbBatch.items.length !== input.issueNumbers.length) {
        throw new ReleaseBranchConflictError(
          `Release batch ${existingDbBatch.id} already exists for branch '${releaseBranch}' with ${existingDbBatch.items.length} items, conflicting with requested ${input.issueNumbers.length} items`,
        );
      }
      for (let i = 0; i < input.issueNumbers.length; i++) {
        if (existingDbBatch.items[i]?.issueNumber !== input.issueNumbers[i]) {
          throw new ReleaseBranchConflictError(
            `Release batch ${existingDbBatch.id} already exists for branch '${releaseBranch}' with different issue numbers`,
          );
        }
      }
    }

    // 10. Create and push release branch if not already on remote
    if (existingRemoteSha === undefined) {
      await this.deps.git.createBranch(repoRoot, releaseBranch, sourceStartSha);
      await this.deps.git.push({
        cwd: repoRoot,
        branch: releaseBranch,
        remote: 'origin',
      });
    }

    // 11. Persist ReleaseBatch aggregate (or reuse existing on retry)
    let batch: ReleaseBatch;
    if (existingDbBatch) {
      batch = existingDbBatch;
    } else {
      const batchId =
        input.batchId ??
        ReleaseBatchId(`batch-${formatUtcDate(startedAt)}-${input.issueNumbers.join('-')}`);
      batch = createReleaseBatch({
        id: batchId,
        repoId,
        sourceBranch,
        sourceStartSha,
        releaseBranch,
        createdAt: startedAt,
        items: input.issueNumbers.map((issueNumber, idx) => ({
          position: idx + 1,
          issueNumber,
          status: 'pending',
        })),
      });
      this.deps.releaseBatchRepository.insert(batch);
    }

    // 12. Initial admission: admit item 0 (position 1)
    const initialIssue = input.issueNumbers[0]!;
    const firstItem = batch.items[0];
    let runUuid: string;
    let runDisplayId: string;
    let jobId: JobId;

    if (firstItem && firstItem.runUuid) {
      // Already admitted on earlier attempt
      runUuid = firstItem.runUuid;
      const existingRun = this.deps.runRepository.findByUuid(runUuid);
      runDisplayId = existingRun ? existingRun.displayId : `issue-${initialIssue}`;
      const repoJobs = this.deps.jobQueue.listForRepo(repoId);
      const existingJob = repoJobs.find((j) => (j.runId as unknown as string) === runUuid);
      jobId = existingJob ? existingJob.id : JobId(randomUUID());
    } else {
      // Look for active run on this issue targeting the release branch
      const activeRun = this.deps.runRepository.findByIssueNumber(repoId, initialIssue);
      let runToAdmit: import('@ai-sdlc/domain').Run;

      if (
        activeRun &&
        activeRun.baseBranch === releaseBranch &&
        !['passed', 'failed', 'cancelled'].includes(activeRun.status)
      ) {
        runToAdmit = activeRun;
        runUuid = activeRun.uuid;
        runDisplayId = activeRun.displayId;
      } else {
        const ids = newRunId({ issueNumber: initialIssue, now: startedAt });
        runUuid = ids.uuid;
        runDisplayId = ids.displayId;
        runToAdmit = createRun({
          uuid: ids.uuid,
          displayId: ids.displayId,
          repoId,
          issueNumber: initialIssue,
          startedAt,
          executionPolicy: input.executionPolicy ?? this.deps.executionPolicy ?? 'standard',
          baseBranch: releaseBranch,
        });
        this.deps.runRepository.insertIfNoActive(runToAdmit);
      }

      // Check / enqueue initial Job
      const repoJobs = this.deps.jobQueue.listForRepo(repoId);
      const existingJob = repoJobs.find((j) => (j.runId as unknown as string) === runUuid);
      if (existingJob) {
        jobId = existingJob.id;
      } else {
        jobId = JobId(randomUUID());
        const job = createJob({
          id: jobId,
          runId: RunId(runUuid),
          repoId,
          issueNumber: IssueNumber(initialIssue),
          priority: 0,
          createdAt: startedAt,
        });
        this.deps.jobQueue.enqueue({ job });
      }

      // Admit item in domain model
      batch = admitItem(batch, 1, {
        runUuid,
        baseSha: sourceStartSha,
        now: startedAt,
      });
      this.deps.releaseBatchRepository.update(batch);
    }

    // 13. Publish structured event
    const eventRepo: EventRepositoryPort | undefined =
      typeof this.deps.eventRepository === 'function'
        ? this.deps.eventRepository(repoId)
        : this.deps.eventRepository;

    const eventPayload = {
      runId: runDisplayId,
      level: 'info' as const,
      type: 'release_batch.started',
      message: `release-batch ${batch.id} started on branch ${releaseBranch} at ${sourceStartSha}, admitted issue #${initialIssue} (run ${runUuid})`,
      timestamp: startedAt.toISOString(),
      metadata: {
        releaseBatchId: batch.id,
        releaseBranch,
        sourceBranch,
        sourceStartSha,
        initialIssue,
        runUuid,
      },
    };

    try {
      this.deps.eventBus.publish(runUuid, eventPayload);
    } catch (err) {
      logger.error?.(`Failed to publish event for release batch ${batch.id}`, err);
    }

    if (eventRepo) {
      try {
        eventRepo.insert({
          runUuid,
          level: eventPayload.level,
          type: eventPayload.type,
          message: eventPayload.message,
          metadata: eventPayload.metadata,
          timestamp: startedAt,
        });
      } catch (err) {
        logger.error?.(`Failed to record event for release batch ${batch.id}`, err);
      }
    }

    return {
      batchId: batch.id,
      releaseBranch,
      sourceBranch,
      sourceStartSha,
      runUuid,
      runDisplayId,
      jobId,
      batch,
    };
  }
}

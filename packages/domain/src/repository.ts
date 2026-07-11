import type { RepositoryId } from './ids.js';

export type RepositoryHealthStatus = 'unknown' | 'healthy' | 'degraded' | 'unreachable';

export interface Repository {
  id: RepositoryId;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  remoteUrl: string;
  localBasePath: string;
  enabled: boolean;
  maxConcurrentRuns: 1;
  healthStatus: RepositoryHealthStatus;
  healthError: string | null;
  lastHealthCheckAt: Date | null;
  /** JSON-encoded config metadata; shape documented in docs/solutions/orchestrator/repository-config-metadata.md */
  configMetadata: string;
  createdAt: Date;
  updatedAt: Date;
}

export function markRepositoryEnabled(repo: Repository, enabled: boolean, now: Date): Repository {
  return { ...repo, enabled, updatedAt: now };
}

export function recordHealthCheck(
  repo: Repository,
  status: RepositoryHealthStatus,
  error: string | null,
  now: Date,
): Repository {
  return {
    ...repo,
    healthStatus: status,
    healthError: error,
    lastHealthCheckAt: now,
    updatedAt: now,
  };
}

export class RepositoryNotApprovedError extends Error {
  readonly repositoryId: RepositoryId;
  constructor(repositoryId: RepositoryId, message?: string) {
    super(message ?? `Repository ${repositoryId} is not approved/registered or is disabled`);
    this.name = 'RepositoryNotApprovedError';
    this.repositoryId = repositoryId;
  }
}

export class RepositoryValidationError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(message);
    this.name = 'RepositoryValidationError';
    this.path = path;
  }
}

export class DuplicateRepositoryError extends Error {
  readonly fullName: string | undefined;
  readonly localBasePath: string | undefined;
  constructor(detail: { fullName?: string; localBasePath?: string }) {
    super(
      `Repository already registered (fullName=${detail.fullName ?? '<n/a>'} localBasePath=${detail.localBasePath ?? '<n/a>'})`,
    );
    this.name = 'DuplicateRepositoryError';
    this.fullName = detail.fullName;
    this.localBasePath = detail.localBasePath;
  }
}

export class RepositoryNotFoundError extends Error {
  readonly identifier: string;
  constructor(identifier: string) {
    super(`Repository not found: ${identifier}`);
    this.name = 'RepositoryNotFoundError';
    this.identifier = identifier;
  }
}

export class RepositoryHasActiveRunsError extends Error {
  readonly repositoryId: RepositoryId;
  readonly activeCount: number;
  constructor(repositoryId: RepositoryId, activeCount: number) {
    super(
      `Repository ${repositoryId} has ${activeCount} active run(s); disable the repo and wait for runs to terminate, then retry removal`,
    );
    this.name = 'RepositoryHasActiveRunsError';
    this.repositoryId = repositoryId;
    this.activeCount = activeCount;
  }
}

export class RunRepositoryMismatchError extends Error {
  readonly runUuid: string;
  readonly expectedRepositoryId: RepositoryId | undefined;
  readonly actualRepositoryId: RepositoryId | undefined;
  constructor(detail: {
    runUuid: string;
    expectedRepositoryId?: RepositoryId;
    actualRepositoryId?: RepositoryId;
  }) {
    super('run does not belong to the supplied repository context');
    this.name = 'RunRepositoryMismatchError';
    this.runUuid = detail.runUuid;
    this.expectedRepositoryId = detail.expectedRepositoryId;
    this.actualRepositoryId = detail.actualRepositoryId;
  }
}

export class RunRepositoryMissingError extends Error {
  readonly identifier: string;
  constructor(identifier: string, message?: string) {
    super(message ?? `repository '${identifier}' is not registered`);
    this.name = 'RunRepositoryMissingError';
    this.identifier = identifier;
  }
}

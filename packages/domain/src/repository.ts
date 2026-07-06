import type { RepositoryId } from './ids.js';

export type RepositoryHealthStatus = 'healthy' | 'unhealthy' | 'unknown';

export interface Repository {
  id: RepositoryId;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  localBasePath: string;
  enabled: boolean;
  maxConcurrentRuns: 1;
  configMetadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  lastHealthCheckAt?: Date;
  healthStatus: RepositoryHealthStatus;
  healthError?: string;
}

export interface RepositoryValidationResult {
  ok: boolean;
  error?: string;
  metadata?: {
    fullName: string;
    defaultBranch: string;
    owner: string;
    name: string;
  };
}

export class RepositoryNotApprovedError extends Error {
  readonly repositoryId: RepositoryId;
  constructor(repositoryId: RepositoryId) {
    super(`Repository ${repositoryId} is not approved/registered or is disabled`);
    this.name = 'RepositoryNotApprovedError';
    this.repositoryId = repositoryId;
  }
}

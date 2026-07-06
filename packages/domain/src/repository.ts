import type { RepositoryId } from './ids.js';

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
  createdAt: Date;
  updatedAt: Date;
}

export class RepositoryNotApprovedError extends Error {
  readonly repositoryId: RepositoryId;
  constructor(repositoryId: RepositoryId) {
    super(`Repository ${repositoryId} is not approved/registered or is disabled`);
    this.name = 'RepositoryNotApprovedError';
    this.repositoryId = repositoryId;
  }
}

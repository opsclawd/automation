import { describe, expect, it, beforeEach } from 'vitest';
import {
  RepositoryId,
  RepositoryNotFoundError,
  RepositoryValidationError,
  type Repository,
} from '@ai-sdlc/domain';
import { FakeRepositoryPort, FakeRepositoryRegistryPort } from '../test-doubles/index.js';
import { RefreshRepository } from '../use-cases/refresh-repository.js';

function seed(overrides: Partial<Repository> = {}): Repository {
  return {
    id: RepositoryId('r1'),
    owner: 'acme',
    name: 'widgets',
    fullName: 'acme/widgets',
    defaultBranch: 'main',
    remoteUrl: 'git@github.com:acme/widgets.git',
    localBasePath: '/repos/widgets',
    enabled: true,
    maxConcurrentRuns: 1,
    healthStatus: 'unknown',
    healthError: null,
    lastHealthCheckAt: null,
    configMetadata: '{}',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('RefreshRepository', () => {
  let repos: FakeRepositoryPort;
  let registry: FakeRepositoryRegistryPort;

  beforeEach(() => {
    const store = new Map();
    const s = seed();
    repos = new FakeRepositoryPort([s], { byId: store, byPath: new Map() });
    registry = new FakeRepositoryRegistryPort({ byId: store });
  });

  it('updates defaultBranch, remoteUrl, and healthStatus on success', () => {
    const resolver = {
      resolve: () => ({
        nameWithOwner: 'acme/widgets',
        defaultBranch: 'trunk',
        remoteUrl: 'git@github.com:acme/widgets2.git',
        rootPath: '/repos/widgets',
      }),
    };
    const uc = new RefreshRepository({ repos, registry, metadataResolver: resolver });
    const after = uc.execute(RepositoryId('r1'));
    expect(after.defaultBranch).toBe('trunk');
    expect(after.remoteUrl).toBe('git@github.com:acme/widgets2.git');
    expect(after.healthStatus).toBe('healthy');
  });

  it('throws RepositoryNotFoundError when the id is unknown', () => {
    const uc = new RefreshRepository({
      repos,
      registry,
      metadataResolver: {
        resolve: () => {
          throw new Error('unused');
        },
      },
    });
    expect(() => uc.execute(RepositoryId('nope'))).toThrow(RepositoryNotFoundError);
  });

  it('records health=unreachable and rethrows when resolver fails', () => {
    const resolver = {
      resolve: () => {
        throw new Error('gh not authenticated');
      },
    };
    const uc = new RefreshRepository({ repos, registry, metadataResolver: resolver });
    expect(() => uc.execute(RepositoryId('r1'))).toThrow(RepositoryValidationError);
    const after = repos.findById(RepositoryId('r1'))!;
    expect(after.healthStatus).toBe('unreachable');
    expect(after.healthError).toBe('gh not authenticated');
  });
});

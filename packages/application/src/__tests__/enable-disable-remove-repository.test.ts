import { describe, expect, it, beforeEach } from 'vitest';
import { FakeRepositoryPort, FakeRepositoryRegistryPort } from '../test-doubles/index.js';
import { EnableRepository } from '../use-cases/enable-repository.js';
import { DisableRepository } from '../use-cases/disable-repository.js';
import { RemoveRepository } from '../use-cases/remove-repository.js';
import {
  RepositoryHasActiveRunsError,
  RepositoryId,
  RepositoryNotFoundError,
  type Repository,
} from '@ai-sdlc/domain';

function seed(overrides: Partial<Repository> = {}): Repository {
  return {
    id: RepositoryId('r1'),
    owner: 'acme',
    name: 'widgets',
    fullName: 'acme/widgets',
    defaultBranch: 'main',
    remoteUrl: 'git@github.com:acme/widgets.git',
    localBasePath: '/repos/widgets',
    enabled: false,
    maxConcurrentRuns: 1,
    healthStatus: 'healthy',
    healthError: null,
    lastHealthCheckAt: null,
    configMetadata: '{}',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('EnableRepository / DisableRepository', () => {
  let repos: FakeRepositoryPort;
  let registry: FakeRepositoryRegistryPort;
  beforeEach(() => {
    const store = new Map();
    const s = seed();
    repos = new FakeRepositoryPort([s], { byId: store, byPath: new Map() });
    registry = new FakeRepositoryRegistryPort({ byId: store });
  });

  it('EnableRepository flips enabled to true', () => {
    const uc = new EnableRepository({ repos, registry });
    const after = uc.execute(RepositoryId('r1'));
    expect(after.enabled).toBe(true);
  });

  it('DisableRepository flips enabled to false', () => {
    repos = new FakeRepositoryPort([seed({ enabled: true })]);
    const uc = new DisableRepository({ repos, registry });
    const after = uc.execute(RepositoryId('r1'));
    expect(after.enabled).toBe(false);
  });

  it('throws RepositoryNotFoundError on unknown id', () => {
    const uc = new DisableRepository({ repos, registry });
    expect(() => uc.execute(RepositoryId('nope'))).toThrow(RepositoryNotFoundError);
  });
});

describe('RemoveRepository', () => {
  it('removes the registry entry when no active runs', () => {
    const store = new Map();
    const s = seed();
    const repos = new FakeRepositoryPort([s], { byId: store, byPath: new Map() });
    const registry = new FakeRepositoryRegistryPort({ byId: store });
    const uc = new RemoveRepository({ repos, registry });
    uc.execute(RepositoryId('r1'));
    expect(repos.findById(RepositoryId('r1'))).toBeUndefined();
  });

  it('blocks removal while active runs exist', () => {
    const store = new Map();
    const s = seed();
    const repos = new FakeRepositoryPort([s], { byId: store, byPath: new Map() });
    const registry = new FakeRepositoryRegistryPort({ byId: store });
    registry.seedActiveRunCount(RepositoryId('r1'), 2);
    const uc = new RemoveRepository({ repos, registry });
    expect(() => uc.execute(RepositoryId('r1'))).toThrow(RepositoryHasActiveRunsError);
  });

  it('throws RepositoryNotFoundError on unknown id', () => {
    const repos = new FakeRepositoryPort([]);
    const registry = new FakeRepositoryRegistryPort();
    const uc = new RemoveRepository({ repos, registry });
    expect(() => uc.execute(RepositoryId('nope'))).toThrow(RepositoryNotFoundError);
  });
});

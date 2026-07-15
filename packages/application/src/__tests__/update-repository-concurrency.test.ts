import { describe, expect, it, beforeEach } from 'vitest';
import { FakeRepositoryPort, FakeRepositoryRegistryPort } from '../test-doubles/index.js';
import { UpdateRepository } from '../use-cases/update-repository.js';
import { RepositoryId, type Repository } from '@ai-sdlc/domain';

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
    healthStatus: 'healthy',
    healthError: null,
    lastHealthCheckAt: null,
    configMetadata: '{}',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('UpdateRepository maxConcurrentRuns', () => {
  let repos: FakeRepositoryPort;
  let registry: FakeRepositoryRegistryPort;

  beforeEach(() => {
    const store = new Map();
    const s = seed();
    repos = new FakeRepositoryPort([s], { byId: store, byPath: new Map() });
    registry = new FakeRepositoryRegistryPort({ byId: store });
  });

  it('persists repository_cap_one_is_persisted', () => {
    const uc = new UpdateRepository({ repos, registry });
    const after = uc.execute({ id: RepositoryId('r1'), maxConcurrentRuns: 1 });
    expect(after.maxConcurrentRuns).toBe(1);
  });

  it('returns repository_cap_round_trips_on_wire', () => {
    const uc = new UpdateRepository({ repos, registry });
    uc.execute({ id: RepositoryId('r1'), maxConcurrentRuns: 1 });
    const listed = repos.listAll();
    expect(listed[0].maxConcurrentRuns).toBe(1);
  });

  it('rejects repository_cap_above_one_fails_closed', () => {
    const uc = new UpdateRepository({ repos, registry });
    expect(() => uc.execute({ id: RepositoryId('r1'), maxConcurrentRuns: 2 })).toThrow(
      /maxConcurrentRuns must be 1/,
    );
  });

  it('rejects non-integer values', () => {
    const uc = new UpdateRepository({ repos, registry });
    expect(() => uc.execute({ id: RepositoryId('r1'), maxConcurrentRuns: 0 })).toThrow(
      /maxConcurrentRuns must be 1/,
    );
  });

  it('rejects negative values', () => {
    const uc = new UpdateRepository({ repos, registry });
    expect(() => uc.execute({ id: RepositoryId('r1'), maxConcurrentRuns: -1 })).toThrow(
      /maxConcurrentRuns must be 1/,
    );
  });
});

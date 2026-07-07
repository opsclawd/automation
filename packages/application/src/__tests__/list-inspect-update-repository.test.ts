import { describe, expect, it, beforeEach } from 'vitest';
import { FakeRepositoryPort, FakeRepositoryRegistryPort } from '../test-doubles/index.js';
import { ListRepositories } from '../use-cases/list-repositories.js';
import { InspectRepository } from '../use-cases/inspect-repository.js';
import { UpdateRepository } from '../use-cases/update-repository.js';
import { RepositoryId, RepositoryNotFoundError, type Repository } from '@ai-sdlc/domain';

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

describe('ListRepositories', () => {
  it('returns only enabled by default and all when includeDisabled', () => {
    const repos = new FakeRepositoryPort([
      seed(),
      seed({ id: RepositoryId('r2'), enabled: false }),
    ]);
    const uc = new ListRepositories({ repos });
    expect(uc.execute()).toHaveLength(1);
    expect(uc.execute({ includeDisabled: true })).toHaveLength(2);
  });
});

describe('InspectRepository', () => {
  it('looks up by id, fullName, and localPath', () => {
    const repos = new FakeRepositoryPort([seed()]);
    const uc = new InspectRepository({ repos });
    expect(uc.executeById(RepositoryId('r1')).fullName).toBe('acme/widgets');
    expect(uc.executeByFullName('acme/widgets').id).toBe('r1');
    expect(uc.executeByLocalPath('/repos/widgets').id).toBe('r1');
  });

  it('throws RepositoryNotFoundError on miss', () => {
    const repos = new FakeRepositoryPort([]);
    const uc = new InspectRepository({ repos });
    expect(() => uc.executeById(RepositoryId('nope'))).toThrow(RepositoryNotFoundError);
  });
});

describe('UpdateRepository', () => {
  let repos: FakeRepositoryPort;
  let registry: FakeRepositoryRegistryPort;

  beforeEach(() => {
    const store = new Map();
    const s = seed();
    repos = new FakeRepositoryPort([s], { byId: store, byPath: new Map() });
    registry = new FakeRepositoryRegistryPort({ byId: store });
  });

  it('mutates defaultBranch and configMetadata', () => {
    const uc = new UpdateRepository({ repos, registry });
    const after = uc.execute({
      id: RepositoryId('r1'),
      defaultBranch: 'trunk',
      configMetadata: '{"source":"cli"}',
    });
    expect(after.defaultBranch).toBe('trunk');
    expect(after.configMetadata).toBe('{"source":"cli"}');
  });

  it('rejects empty defaultBranch', () => {
    const uc = new UpdateRepository({ repos, registry });
    expect(() => uc.execute({ id: RepositoryId('r1'), defaultBranch: '   ' })).toThrow(/empty/);
  });

  it('throws RepositoryNotFoundError on unknown id', () => {
    const uc = new UpdateRepository({ repos, registry });
    expect(() => uc.execute({ id: RepositoryId('nope') })).toThrow(RepositoryNotFoundError);
  });
});

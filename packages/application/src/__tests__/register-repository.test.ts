import { describe, expect, it, beforeEach } from 'vitest';
import { RepositoryValidationError, RepositoryId, type Repository } from '@ai-sdlc/domain';
import { FakeRepositoryPort, FakeRepositoryRegistryPort } from '../test-doubles/index.js';
import { RegisterRepository } from '../use-cases/register-repository.js';

function fakeMetadata(
  overrides: Partial<{
    nameWithOwner: string;
    defaultBranch: string;
    remoteUrl: string;
    rootPath: string;
  }> = {},
) {
  return {
    nameWithOwner: 'acme/widgets',
    defaultBranch: 'main',
    remoteUrl: 'git@github.com:acme/widgets.git',
    rootPath: '/repos/widgets',
    ...overrides,
  };
}

describe('RegisterRepository', () => {
  let repos: FakeRepositoryPort;
  let registry: FakeRepositoryRegistryPort;

  beforeEach(() => {
    repos = new FakeRepositoryPort([]);
    registry = new FakeRepositoryRegistryPort();
  });

  it('resolves metadata, builds a Repository, and inserts it', () => {
    const resolver = { resolve: () => fakeMetadata() };
    const uc = new RegisterRepository({ repos, registry, metadataResolver: resolver });
    const repo = uc.execute({ localPath: '/repos/widgets' });
    expect(repo.fullName).toBe('acme/widgets');
    expect(repo.owner).toBe('acme');
    expect(repo.name).toBe('widgets');
    expect(repo.healthStatus).toBe('healthy');
    expect(registry.findActiveRunCount(repo.id)).toBe(0);
  });

  it('wraps resolver errors as RepositoryValidationError', () => {
    const resolver = {
      resolve: () => {
        throw new Error('not a git worktree');
      },
    };
    const uc = new RegisterRepository({ repos, registry, metadataResolver: resolver });
    expect(() => uc.execute({ localPath: '/bad' })).toThrow(RepositoryValidationError);
  });

  it('rejects duplicate full_name before hitting the registry', () => {
    const existing: Repository = {
      id: RepositoryId('existing-id'),
      owner: 'acme',
      name: 'widgets',
      fullName: 'acme/widgets',
      defaultBranch: 'main',
      remoteUrl: 'url',
      localBasePath: '/other/path',
      enabled: true,
      maxConcurrentRuns: 1,
      healthStatus: 'healthy',
      healthError: null,
      lastHealthCheckAt: null,
      configMetadata: '{}',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    repos = new FakeRepositoryPort([existing]);
    const resolver = { resolve: () => fakeMetadata() };
    const uc = new RegisterRepository({ repos, registry, metadataResolver: resolver });
    expect(() => uc.execute({ localPath: '/repos/widgets' })).toThrow(/already registered/);
  });

  it('rejects malformed nameWithOwner', () => {
    const resolver = { resolve: () => fakeMetadata({ nameWithOwner: 'no-slash' }) };
    const uc = new RegisterRepository({ repos, registry, metadataResolver: resolver });
    expect(() => uc.execute({ localPath: '/repos/widgets' })).toThrow(/not in owner\/name form/);
  });
});

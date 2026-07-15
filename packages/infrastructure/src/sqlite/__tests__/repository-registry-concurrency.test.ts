import { describe, expect, it, beforeEach } from 'vitest';
import { openDatabase } from '../../index.js';
import { RepositoryRegistryRepository } from '../repository-registry-repository.js';
import { applyMigrations } from '../../index.js';
import { type Repository, RepositoryId } from '@ai-sdlc/domain';

function repo(overrides: Partial<Repository> = {}): Repository {
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
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('RepositoryRegistryRepository maxConcurrentRuns', () => {
  let db: ReturnType<typeof openDatabase>;
  let port: RepositoryRegistryRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    applyMigrations(db);
    port = new RepositoryRegistryRepository(db);
  });

  it('persists repository_cap_one_is_persisted', () => {
    port.insert(repo());
    port.update(
      RepositoryId('r1'),
      { maxConcurrentRuns: 1 as const },
      new Date('2026-02-01T00:00:00Z'),
    );
    const row = db
      .prepare(`SELECT max_concurrent_runs FROM repositories WHERE id = 'r1'`)
      .get() as {
      max_concurrent_runs: number;
    };
    expect(row.max_concurrent_runs).toBe(1);
  });

  it('returns repository_cap_round_trips_on_wire', () => {
    port.insert(repo());
    port.update(
      RepositoryId('r1'),
      { maxConcurrentRuns: 1 as const },
      new Date('2026-02-01T00:00:00Z'),
    );
    const found = port.findById(RepositoryId('r1'));
    expect(found?.maxConcurrentRuns).toBe(1);
  });

  it('rejects repository_cap_above_one_fails_closed via use case', () => {
    port.insert(repo());
    expect(() =>
      port.update(RepositoryId('r1'), { maxConcurrentRuns: 2 as const }, new Date()),
    ).toThrow(/maxConcurrentRuns must be 1/);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteRepositoryRepository } from '../repository-repository.js';
import { openDatabase, type Db } from '../database.js';
import { applyMigrations } from '../migrations.js';
import { RepositoryId } from '@ai-sdlc/domain';

describe('SqliteRepositoryRepository', () => {
  let db: Db;
  let repo: SqliteRepositoryRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    applyMigrations(db);
    repo = new SqliteRepositoryRepository(db);
  });

  it('upserts and finds a repository by ID', () => {
    const r = {
      id: RepositoryId('repo-1'),
      owner: 'owner',
      name: 'name',
      fullName: 'owner/name',
      defaultBranch: 'main',
      localBasePath: '/tmp/repo-1',
      enabled: true,
      maxConcurrentRuns: 1 as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    repo.upsert(r);

    const found = repo.findById(r.id);
    expect(found).toBeDefined();
    expect(found?.fullName).toBe('owner/name');
  });

  it('finds a repository by full name', () => {
    const r = {
      id: RepositoryId('repo-1'),
      owner: 'owner',
      name: 'name',
      fullName: 'owner/name',
      defaultBranch: 'main',
      localBasePath: '/tmp/repo-1',
      enabled: true,
      maxConcurrentRuns: 1 as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    repo.upsert(r);

    const found = repo.findByFullName('owner/name');
    expect(found).toBeDefined();
    expect(found?.id).toBe('repo-1');
  });

  it('lists enabled repositories', () => {
    repo.upsert({
      id: RepositoryId('repo-1'),
      owner: 'o1',
      name: 'n1',
      fullName: 'o1/n1',
      defaultBranch: 'main',
      localBasePath: '/tmp/1',
      enabled: true,
      maxConcurrentRuns: 1 as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    repo.upsert({
      id: RepositoryId('repo-2'),
      owner: 'o2',
      name: 'n2',
      fullName: 'o2/n2',
      defaultBranch: 'main',
      localBasePath: '/tmp/2',
      enabled: false,
      maxConcurrentRuns: 1 as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const enabled = repo.listEnabled();
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.id).toBe('repo-1');
  });
});

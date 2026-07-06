import { describe, expect, it, beforeEach } from 'vitest';
import { openDatabase } from '../database.js';
import { applyMigrations } from '../migrations.js';
import { SqliteRepositoryRepository } from '../repository-repository.js';
import { RepositoryId } from '@ai-sdlc/domain';

describe('SqliteRepositoryRepository', () => {
  let db: any;
  let repo: SqliteRepositoryRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    applyMigrations(db);
    repo = new SqliteRepositoryRepository(db);
  });

  it('inserts and finds a repository by ID', () => {
    const r = {
      id: RepositoryId('org/repo'),
      owner: 'org',
      name: 'repo',
      fullName: 'org/repo',
      defaultBranch: 'main',
      localBasePath: '/tmp/repo',
      enabled: true,
      maxConcurrentRuns: 1 as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    repo.insert(r);
    const found = repo.findById(r.id);
    expect(found).toMatchObject({
      ...r,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
  });

  it('finds a repository by full name', () => {
    const r = {
        id: RepositoryId('org/repo'),
        owner: 'org',
        name: 'repo',
        fullName: 'org/repo',
        defaultBranch: 'main',
        localBasePath: '/tmp/repo',
        enabled: true,
        maxConcurrentRuns: 1 as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      repo.insert(r);
      const found = repo.findByFullName(r.fullName);
      expect(found?.id).toBe(r.id);
  });

  it('lists enabled repositories', () => {
    const r1 = {
        id: RepositoryId('org/repo1'),
        owner: 'org',
        name: 'repo1',
        fullName: 'org/repo1',
        defaultBranch: 'main',
        localBasePath: '/tmp/repo1',
        enabled: true,
        maxConcurrentRuns: 1 as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const r2 = {
        id: RepositoryId('org/repo2'),
        owner: 'org',
        name: 'repo2',
        fullName: 'org/repo2',
        defaultBranch: 'main',
        localBasePath: '/tmp/repo2',
        enabled: false,
        maxConcurrentRuns: 1 as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      repo.insert(r1);
      repo.insert(r2);

      const enabled = repo.listEnabled();
      expect(enabled).toHaveLength(1);
      expect(enabled[0]?.id).toBe(r1.id);
  });
});

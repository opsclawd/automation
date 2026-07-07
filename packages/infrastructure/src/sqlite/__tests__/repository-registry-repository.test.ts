import { describe, expect, it, beforeEach } from 'vitest';
import { openDatabase } from '../../index.js';
import { RepositoryRegistryRepository } from '../repository-registry-repository.js';
import { applyMigrations } from '../../index.js';
import {
  DuplicateRepositoryError,
  RepositoryHasActiveRunsError,
  RepositoryNotFoundError,
  type Repository,
} from '@ai-sdlc/domain';
import { RepositoryId } from '@ai-sdlc/domain';

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

describe('RepositoryRegistryRepository', () => {
  let db: ReturnType<typeof openDatabase>;
  let port: RepositoryRegistryRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    applyMigrations(db);
    port = new RepositoryRegistryRepository(db);
  });

  it('insert persists a row and findActiveRunCount is zero', () => {
    port.insert(repo());
    const row = db.prepare(`SELECT full_name, owner FROM repositories WHERE id = 'r1'`).get() as {
      full_name: string;
      owner: string;
    };
    expect(row.full_name).toBe('acme/widgets');
    expect(row.owner).toBe('acme');
    expect(port.findActiveRunCount(RepositoryId('r1'))).toBe(0);
  });

  it('rejects duplicate full_name with DuplicateRepositoryError', () => {
    port.insert(repo());
    expect(() => port.insert(repo({ id: RepositoryId('r2'), localBasePath: '/other' }))).toThrow(
      DuplicateRepositoryError,
    );
  });

  it('rejects duplicate local_base_path with DuplicateRepositoryError', () => {
    port.insert(repo());
    expect(() => port.insert(repo({ id: RepositoryId('r2'), fullName: 'foo/bar' }))).toThrow(
      DuplicateRepositoryError,
    );
  });

  it('update mutates only listed columns', () => {
    port.insert(repo());
    port.update(
      RepositoryId('r1'),
      { enabled: false, healthStatus: 'healthy' },
      new Date('2026-02-01T00:00:00Z'),
    );
    const row = db
      .prepare(`SELECT enabled, health_status, updated_at FROM repositories WHERE id = 'r1'`)
      .get() as {
      enabled: number;
      health_status: string;
      updated_at: string;
    };
    expect(row.enabled).toBe(0);
    expect(row.health_status).toBe('healthy');
    expect(row.updated_at).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('remove throws RepositoryHasActiveRunsError when runs exist', () => {
    port.insert(repo());
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, started_at, repo_id)
       VALUES ('run-1', 'run-1', 1, 'issue', 'running', '2026-01-01T00:00:00.000Z', 'r1')`,
    ).run();
    expect(() => port.remove(RepositoryId('r1'))).toThrow(RepositoryHasActiveRunsError);
    expect(port.findActiveRunCount(RepositoryId('r1'))).toBe(1);
  });

  it('remove succeeds when only terminal runs exist', () => {
    port.insert(repo());
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, started_at, repo_id)
       VALUES ('run-1', 'run-1', 1, 'issue', 'passed', '2026-01-01T00:00:00.000Z', 'r1')`,
    ).run();
    expect(() => port.remove(RepositoryId('r1'))).not.toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS c FROM repositories`).get()).toEqual({ c: 0 });
  });

  it('remove throws RepositoryNotFoundError when id is unknown', () => {
    expect(() => port.remove(RepositoryId('nope'))).toThrow(RepositoryNotFoundError);
  });
});

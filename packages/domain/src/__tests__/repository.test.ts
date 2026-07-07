import { describe, expect, it } from 'vitest';
import {
  markRepositoryEnabled,
  recordHealthCheck,
  RepositoryValidationError,
  DuplicateRepositoryError,
  RepositoryNotFoundError,
  RepositoryHasActiveRunsError,
  type Repository,
} from '../repository.js';
import { RepositoryId } from '../ids.js';

const baseRepo: Repository = {
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
};

describe('Repository registry helpers', () => {
  it('markRepositoryEnabled toggles the boolean and refreshes updatedAt', () => {
    const next = markRepositoryEnabled(baseRepo, false, new Date('2026-02-01T00:00:00Z'));
    expect(next.enabled).toBe(false);
    expect(next.updatedAt.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('recordHealthCheck writes status, optional error, and timestamp', () => {
    const at = new Date('2026-02-02T00:00:00Z');
    const ok = recordHealthCheck(baseRepo, 'healthy', null, at);
    expect(ok.healthStatus).toBe('healthy');
    expect(ok.healthError).toBeNull();
    expect(ok.lastHealthCheckAt?.toISOString()).toBe(at.toISOString());
    expect(ok.updatedAt.toISOString()).toBe(at.toISOString());

    const bad = recordHealthCheck(baseRepo, 'unreachable', 'gh not authenticated', at);
    expect(bad.healthStatus).toBe('unreachable');
    expect(bad.healthError).toBe('gh not authenticated');
  });
});

describe('Repository registry errors', () => {
  it('RepositoryValidationError carries the message and path', () => {
    const e = new RepositoryValidationError('not a git worktree', '/tmp/foo');
    expect(e.name).toBe('RepositoryValidationError');
    expect(e.path).toBe('/tmp/foo');
    expect(e.message).toBe('not a git worktree');
  });

  it('DuplicateRepositoryError exposes fullName and localBasePath', () => {
    const e = new DuplicateRepositoryError({ fullName: 'a/b', localBasePath: '/r' });
    expect(e.name).toBe('DuplicateRepositoryError');
    expect(e.fullName).toBe('a/b');
    expect(e.localBasePath).toBe('/r');
  });

  it('RepositoryNotFoundError carries the id or fullName', () => {
    const e = new RepositoryNotFoundError('r1');
    expect(e.name).toBe('RepositoryNotFoundError');
    expect(e.identifier).toBe('r1');
  });

  it('RepositoryHasActiveRunsError carries id and active count', () => {
    const e = new RepositoryHasActiveRunsError('r1', 3);
    expect(e.name).toBe('RepositoryHasActiveRunsError');
    expect(e.activeCount).toBe(3);
  });
});

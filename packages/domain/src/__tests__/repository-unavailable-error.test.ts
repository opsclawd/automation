import { describe, it, expect } from 'vitest';
import { RepositoryUnavailableError } from '../repository.js';

describe('RepositoryUnavailableError', () => {
  it('stores repository ID and full name', () => {
    const error = new RepositoryUnavailableError({
      repositoryId: 'owner/repo',
      fullName: 'owner/repo',
      localPath: '/data/repos/owner/repo',
      operation: 'prepareWorktree',
      cause: 'ENOENT: no such file or directory',
      code: 'ENOTFOUND',
    });

    expect(error.repositoryId).toBe('owner/repo');
    expect(error.fullName).toBe('owner/repo');
    expect(error.localPath).toBe('/data/repos/owner/repo');
    expect(error.operation).toBe('prepareWorktree');
    expect(error.cause).toBe('ENOENT: no such file or directory');
    expect(error.code).toBe('ENOTFOUND');
    expect(error.operatorAction).toBe(
      'Restore the path or mount, then refresh repository health before retrying.',
    );
  });

  it('includes operator action for recovery guidance', () => {
    const error = new RepositoryUnavailableError({
      repositoryId: 'owner/repo',
      fullName: 'owner/repo',
      localPath: '/data/repos/owner/repo',
      operation: 'prepareWorktree',
      cause: 'disk I/O error',
      code: 'EIO',
    });

    expect(error.operatorAction).toBe(
      'Restore the path or mount, then refresh repository health before retrying.',
    );
  });

  it('has a meaningful error message', () => {
    const error = new RepositoryUnavailableError({
      repositoryId: 'owner/repo',
      fullName: 'owner/repo',
      localPath: '/data/repos/owner/repo',
      operation: 'prepareWorktree',
      cause: 'ENOENT: no such file or directory',
      code: 'ENOTFOUND',
    });

    expect(error.message).toContain('owner/repo');
    expect(error.message).toContain('prepareWorktree');
    expect(error.message).toContain('ENOTFOUND');
  });

  it('is an instance of Error', () => {
    const error = new RepositoryUnavailableError({
      repositoryId: 'owner/repo',
      fullName: 'owner/repo',
      localPath: '/data/repos/owner/repo',
      operation: 'prepareWorktree',
      cause: 'disk I/O error',
      code: 'EIO',
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RepositoryUnavailableError');
  });
});

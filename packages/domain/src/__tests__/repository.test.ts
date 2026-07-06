import { describe, expect, it } from 'vitest';
import { Repository, RepositoryNotApprovedError } from '../repository.js';
import { RepositoryId } from '../ids.js';

describe('Repository', () => {
  it('exposes RepositoryNotApprovedError class', () => {
    const e = new RepositoryNotApprovedError(RepositoryId('r'));
    expect(e.name).toBe('RepositoryNotApprovedError');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toContain('r');
  });
  it('Repository type carries expected fields (compile-time)', () => {
    const r: Repository = {
      id: RepositoryId('r'),
      owner: 'o',
      name: 'n',
      fullName: 'o/n',
      defaultBranch: 'main',
      localBasePath: '/tmp/r',
      enabled: true,
      maxConcurrentRuns: 1,
      configMetadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      healthStatus: 'unknown',
    };
    expect(r.maxConcurrentRuns).toBe(1);
    expect(r.configMetadata).toEqual({});
    expect(r.healthStatus).toBe('unknown');
  });
});

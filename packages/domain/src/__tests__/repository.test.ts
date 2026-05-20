import { describe, expect, it } from 'vitest';
import { Repository, RepositoryNotApprovedError } from '../repository.js';
import { RepositoryId } from '../ids.js';

describe('Repository', () => {
  it('exposes RepositoryNotApprovedError class', () => {
    const e = new RepositoryNotApprovedError(RepositoryId('r'));
    expect(e.name).toBe('RepositoryNotApprovedError');
    expect(e).toBeInstanceOf(Error);
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
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(r.maxConcurrentRuns).toBe(1);
  });
});

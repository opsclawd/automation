import { describe, expect, it } from 'vitest';
import { RepositoryId } from '@ai-sdlc/domain';
import { FakeRepositoryPort } from '../test-doubles/index.js';

describe('FakeRepositoryPort', () => {
  it('returns undefined for an unknown id', () => {
    const p = new FakeRepositoryPort([]);
    expect(p.findById(RepositoryId('missing'))).toBeUndefined();
  });
  it('returns the repository for a known id', () => {
    const p = new FakeRepositoryPort([
      {
        id: RepositoryId('r1'),
        owner: 'o',
        name: 'n',
        fullName: 'o/n',
        defaultBranch: 'main',
        localBasePath: '/tmp/r1',
        enabled: true,
        maxConcurrentRuns: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    expect(p.findById(RepositoryId('r1'))?.fullName).toBe('o/n');
  });
  it('listEnabled excludes disabled repos', () => {
    const base = {
      owner: 'o',
      name: 'n',
      defaultBranch: 'main',
      localBasePath: '/x',
      maxConcurrentRuns: 1 as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const p = new FakeRepositoryPort([
      { ...base, id: RepositoryId('a'), fullName: 'o/a', enabled: true },
      { ...base, id: RepositoryId('b'), fullName: 'o/b', enabled: false },
    ]);
    expect(p.listEnabled().map((r) => r.id)).toEqual(['a']);
  });
  it('findByFullName works', () => {
    const p = new FakeRepositoryPort([
      {
        id: RepositoryId('r1'),
        owner: 'o',
        name: 'n',
        fullName: 'o/n',
        defaultBranch: 'main',
        localBasePath: '/x',
        enabled: true,
        maxConcurrentRuns: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    expect(p.findByFullName('o/n')?.id).toBe('r1');
  });
  it('findByFullName returns undefined for unknown name', () => {
    const p = new FakeRepositoryPort([]);
    expect(p.findByFullName('unknown/o')).toBeUndefined();
  });
});

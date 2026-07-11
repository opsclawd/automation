// packages/application/src/use-cases/__tests__/load-repository-for-run.test.ts
import { describe, it, expect } from 'vitest';
import { LoadRepositoryForRun } from '../load-repository-for-run.js';
import { RunRepositoryMismatchError, RunRepositoryMissingError } from '@ai-sdlc/domain';
import type { Repository, Run } from '@ai-sdlc/domain';
import type { RepositoryPort } from '../../ports/repository-port.js';

const repoA = {
  id: 'a'.repeat(64),
  fullName: 'owner/repo-a',
  enabled: true,
  healthStatus: 'healthy',
} as unknown as Repository;
const repoB = {
  id: 'b'.repeat(64),
  fullName: 'owner/repo-b',
  enabled: true,
  healthStatus: 'healthy',
} as unknown as Repository;

function makePort() {
  return {
    findById: (id: string) => [repoA, repoB].find((r) => r.id === id),
    findByFullName: (n: string) => [repoA, repoB].find((r) => r.fullName === n),
    list: () => [repoA, repoB],
    listEnabled: () => [repoA, repoB],
  };
}

function makeRun(repoId: string) {
  return { uuid: 'u1', repoId } as unknown as Run;
}

describe('LoadRepositoryForRun', () => {
  it('returns repo when callerRepoId matches run.repoId', () => {
    const uc = new LoadRepositoryForRun({
      repositoryPort: makePort() as unknown as RepositoryPort,
    });
    const result = uc.execute({
      run: makeRun(repoA.id),
      callerRepoId: repoA.id,
      strictMatch: true,
    });
    expect(result.id).toBe(repoA.id);
  });

  it('throws RunRepositoryMismatchError when callerRepoId differs from run.repoId (strictMatch)', () => {
    const uc = new LoadRepositoryForRun({
      repositoryPort: makePort() as unknown as RepositoryPort,
    });
    expect(() =>
      uc.execute({ run: makeRun(repoA.id), callerRepoId: repoB.id, strictMatch: true }),
    ).toThrow(RunRepositoryMismatchError);
  });

  it('throws RunRepositoryMismatchError when callerRepoId differs (non-strict) too', () => {
    const uc = new LoadRepositoryForRun({
      repositoryPort: makePort() as unknown as RepositoryPort,
    });
    expect(() =>
      uc.execute({ run: makeRun(repoA.id), callerRepoId: repoB.id, strictMatch: false }),
    ).toThrow(RunRepositoryMismatchError);
  });

  it('resolves callerFullName to a canonical id and validates it', () => {
    const uc = new LoadRepositoryForRun({
      repositoryPort: makePort() as unknown as RepositoryPort,
    });
    expect(
      uc.execute({ run: makeRun(repoA.id), callerFullName: 'owner/repo-a', strictMatch: true }).id,
    ).toBe(repoA.id);
    expect(() =>
      uc.execute({ run: makeRun(repoA.id), callerFullName: 'owner/repo-b', strictMatch: true }),
    ).toThrow(RunRepositoryMismatchError);
  });

  it('throws RunRepositoryMissingError when no caller context is supplied', () => {
    const uc = new LoadRepositoryForRun({
      repositoryPort: makePort() as unknown as RepositoryPort,
    });
    expect(() => uc.execute({ run: makeRun(repoA.id), strictMatch: false })).toThrow(
      RunRepositoryMissingError,
    );
  });

  it('throws RunRepositoryMissingError when strictMatch is true and no caller context is supplied', () => {
    const uc = new LoadRepositoryForRun({
      repositoryPort: makePort() as unknown as RepositoryPort,
    });
    expect(() => uc.execute({ run: makeRun(repoA.id), strictMatch: true })).toThrow(
      RunRepositoryMissingError,
    );
  });

  it('throws RunRepositoryMissingError when run.repoId is not registered anymore', () => {
    const port = makePort();
    port.findById = () => undefined;
    const uc = new LoadRepositoryForRun({ repositoryPort: port as unknown as RepositoryPort });
    expect(() =>
      uc.execute({
        run: makeRun('z'.repeat(64)),
        callerRepoId: 'z'.repeat(64),
        strictMatch: false,
      }),
    ).toThrow(RunRepositoryMissingError);
  });
});

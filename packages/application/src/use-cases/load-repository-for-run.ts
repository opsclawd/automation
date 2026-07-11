import type { Repository, RepositoryId, Run } from '@ai-sdlc/domain';
import { RunRepositoryMismatchError, RunRepositoryMissingError } from '@ai-sdlc/domain';
import type { RepositoryPort } from '../ports/repository-port.js';

export type LoadRepositoryForRunInput = {
  run: Run;
  callerRepoId?: RepositoryId;
  callerFullName?: string;
  strictMatch: boolean;
};

export type LoadRepositoryForRunDeps = {
  repositoryPort: Pick<RepositoryPort, 'findById' | 'findByFullName'>;
};

export class LoadRepositoryForRun {
  constructor(private readonly deps: LoadRepositoryForRunDeps) {}

  execute(input: LoadRepositoryForRunInput): Repository {
    const { run, callerRepoId, callerFullName, strictMatch } = input;
    const { repositoryPort } = this.deps;

    if (strictMatch && !callerRepoId && !callerFullName) {
      throw new RunRepositoryMissingError(
        '<none>',
        'strict match requires an explicit repository context',
      );
    }

    let resolved: Repository | undefined;
    if (callerRepoId) {
      resolved = repositoryPort.findById(callerRepoId);
    } else if (callerFullName) {
      resolved = repositoryPort.findByFullName(callerFullName);
    } else {
      throw new RunRepositoryMissingError('<none>', 'no repository context supplied by caller');
    }

    if (!resolved) {
      throw new RunRepositoryMissingError(callerRepoId ?? callerFullName ?? '<none>');
    }

    if (run.repoId !== resolved.id) {
      throw new RunRepositoryMismatchError({
        runUuid: run.uuid,
        expectedRepositoryId: resolved.id,
        actualRepositoryId: run.repoId,
      });
    }

    const owning = repositoryPort.findById(run.repoId);
    if (!owning) {
      throw new RunRepositoryMissingError(
        run.repoId,
        'run is owned by a repository that is no longer registered',
      );
    }

    return owning;
  }
}

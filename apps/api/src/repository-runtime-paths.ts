import { join } from 'node:path';
import type { Repository, RepositoryId } from '@ai-sdlc/domain';

const UNSAFE_SEGMENT_PATTERN = /[\/\s\\]/;

function isUnsafeSegment(value: string): boolean {
  if (!value || value.trim() !== value) {
    return true;
  }
  if (UNSAFE_SEGMENT_PATTERN.test(value)) {
    return true;
  }
  if (value === '..' || value === '.') {
    return true;
  }
  return false;
}

export interface RepositoryRuntimePaths {
  readonly repositoryId: RepositoryId;
  worktree(issueNumber: number): string;
  run(displayId: string): string;
  database(): string;
  tmp(runUuid: string): string;
  agentArtifacts(): string;
  validationLog(displayId: string, checkId: string): string;
  prompt(runUuid: string, purpose: string): string;
}

export interface RepositoryRuntimePathsOptions {
  stateRoot: string;
  repository: Repository;
}

export const RepositoryRuntimePaths = {
  create({ stateRoot, repository }: RepositoryRuntimePathsOptions): RepositoryRuntimePaths {
    const { owner, name, fullName } = repository;

    if (isUnsafeSegment(owner)) {
      throw new Error(`Invalid repository owner: ${owner}`);
    }
    if (isUnsafeSegment(name)) {
      throw new Error(`Invalid repository name: ${name}`);
    }
    if (fullName !== `${owner}/${name}`) {
      throw new Error(
        `Repository fullName '${fullName}' does not match owner/name '${owner}/${name}'`,
      );
    }

    const namespace = `${owner}/${name}`;
    const worktreesRoot = join(stateRoot, '.ai-worktrees', namespace);
    const runsRoot = join(stateRoot, '.ai-runs', namespace);
    const stateDir = join(stateRoot, '.ai-state', namespace);
    const tmpRoot = join(stateRoot, '.ai-tmp', namespace);
    const artifactsRoot = join(stateRoot, '.ai-artifacts', namespace);

    return {
      repositoryId: repository.id,

      worktree(issueNumber: number): string {
        return join(worktreesRoot, `issue-${issueNumber}`);
      },

      run(displayId: string): string {
        if (isUnsafeSegment(displayId)) {
          throw new Error(`Invalid displayId: ${displayId}`);
        }
        return join(runsRoot, displayId);
      },

      database(): string {
        return join(stateDir, 'orchestrator.sqlite');
      },

      tmp(runUuid: string): string {
        if (isUnsafeSegment(runUuid)) {
          throw new Error(`Invalid runUuid: ${runUuid}`);
        }
        return join(tmpRoot, runUuid);
      },

      agentArtifacts(): string {
        return artifactsRoot;
      },

      validationLog(displayId: string, checkId: string): string {
        if (isUnsafeSegment(displayId)) {
          throw new Error(`Invalid displayId: ${displayId}`);
        }
        if (isUnsafeSegment(checkId)) {
          throw new Error(`Invalid checkId: ${checkId}`);
        }
        return join(runsRoot, displayId, `validation-${checkId}.log`);
      },

      prompt(runUuid: string, purpose: string): string {
        if (isUnsafeSegment(runUuid)) {
          throw new Error(`Invalid runUuid: ${runUuid}`);
        }
        if (isUnsafeSegment(purpose)) {
          throw new Error(`Invalid purpose: ${purpose}`);
        }
        return join(tmpRoot, runUuid, `prompt-${purpose}.txt`);
      },
    };
  },
};

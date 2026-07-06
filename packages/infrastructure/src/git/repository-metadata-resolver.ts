import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RepositoryMetadata {
  rootPath: string;
  nameWithOwner: string;
  defaultBranch: string;
  remoteUrl: string;
}

export class RepositoryResolutionError extends Error {
  constructor(message: string, public readonly path: string) {
    super(message);
    this.name = 'RepositoryResolutionError';
  }
}

export class RepositoryMetadataResolver {
  resolve(targetPath: string): RepositoryMetadata {
    const absolutePath = resolve(process.cwd(), targetPath);

    if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) {
      throw new RepositoryResolutionError(
        `Target path is not an existing directory: ${absolutePath}`,
        absolutePath,
      );
    }

    // 1. Resolve rootPath (the git top-level directory)
    let rootPath: string;
    try {
      rootPath = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: absolutePath,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
      }).trim();
    } catch {
      throw new RepositoryResolutionError(
        `Path is not inside a git working tree: ${absolutePath}`,
        absolutePath,
      );
    }

    // 2. Resolve nameWithOwner (repo identity)
    let nameWithOwner: string;
    try {
      nameWithOwner = execFileSync(
        'gh',
        ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
        {
          cwd: rootPath,
          stdio: ['ignore', 'pipe', 'ignore'],
          encoding: 'utf-8',
        },
      ).trim();
    } catch {
      throw new RepositoryResolutionError(
        `Failed to resolve repository identity via gh CLI in ${rootPath}. Ensure gh is authenticated and the repository has a GitHub remote.`,
        rootPath,
      );
    }

    // 3. Resolve defaultBranch
    let defaultBranch: string;
    try {
      defaultBranch = execFileSync(
        'gh',
        ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'],
        {
          cwd: rootPath,
          stdio: ['ignore', 'pipe', 'ignore'],
          encoding: 'utf-8',
        },
      ).trim();
    } catch {
      // Fallback to a common default if gh fails for defaultBranch specifically
      // but only if we already succeeded in identifying the repo.
      defaultBranch = 'main';
    }

    // 4. Resolve remoteUrl
    let remoteUrl: string;
    try {
      remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: rootPath,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
      }).trim();
    } catch {
      throw new RepositoryResolutionError(
        `Failed to resolve remote URL for 'origin' in ${rootPath}.`,
        rootPath,
      );
    }

    return {
      rootPath,
      nameWithOwner,
      defaultBranch,
      remoteUrl,
    };
  }
}

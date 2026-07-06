import {
  type Repository,
  type RepositoryId,
} from '@ai-sdlc/domain';
import type { RepositoryRegistryPort, GitHubPort, GitPort } from '../ports.js';

export interface RefreshRepositoryInput {
  id: RepositoryId;
}

export class RefreshRepository {
  constructor(
    private readonly repos: RepositoryRegistryPort,
    private readonly github: GitHubPort,
    private readonly git: GitPort,
  ) {}

  async execute(input: RefreshRepositoryInput): Promise<Repository> {
    const repo = this.repos.findById(input.id);
    if (!repo) {
      throw new Error(`Repository not found: ${input.id}`);
    }

    try {
      const fullName = await this.git.resolveFullName(repo.localBasePath);
      const repoInfo = await this.github.getRepo(fullName);

      const updatedRepo: Repository = {
        ...repo,
        fullName,
        owner: repoInfo.owner,
        name: repoInfo.name,
        defaultBranch: repoInfo.defaultBranch,
        healthStatus: 'healthy',
        lastHealthCheckAt: new Date(),
        updatedAt: new Date(),
      };

      this.repos.save(updatedRepo);
      return updatedRepo;
    } catch (err) {
      const updatedRepo: Repository = {
        ...repo,
        healthStatus: 'unhealthy',
        healthError: String(err),
        lastHealthCheckAt: new Date(),
        updatedAt: new Date(),
      };
      this.repos.save(updatedRepo);
      throw err;
    }
  }
}

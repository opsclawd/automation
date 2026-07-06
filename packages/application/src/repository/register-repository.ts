import {
  type Repository,
  RepositoryId as mkRepositoryId,
  type RepositoryValidationResult,
} from '@ai-sdlc/domain';
import type { RepositoryRegistryPort, GitHubPort, GitPort } from '../ports.js';

export interface RegisterRepositoryInput {
  localBasePath: string;
  id?: string;
  enabled?: boolean;
}

export class RegisterRepository {
  constructor(
    private readonly repos: RepositoryRegistryPort,
    private readonly github: GitHubPort,
    private readonly git: GitPort,
  ) {}

  async execute(input: RegisterRepositoryInput): Promise<Repository> {
    const validation = await this.validate(input.localBasePath);
    if (!validation.ok || !validation.metadata) {
      throw new Error(`Repository validation failed: ${validation.error}`);
    }

    const { fullName, defaultBranch, owner, name } = validation.metadata;

    const existingPath = this.repos.findByLocalPath(input.localBasePath);
    if (existingPath) {
      throw new Error(`Repository already registered at path: ${input.localBasePath}`);
    }

    const existingFullName = this.repos.findByFullName(fullName);
    if (existingFullName) {
      throw new Error(`Repository already registered with identity: ${fullName}`);
    }

    const repository: Repository = {
      id: mkRepositoryId(input.id ?? fullName),
      owner,
      name,
      fullName,
      defaultBranch,
      localBasePath: input.localBasePath,
      enabled: input.enabled ?? true,
      maxConcurrentRuns: 1,
      configMetadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      healthStatus: 'healthy',
      lastHealthCheckAt: new Date(),
    };

    this.repos.save(repository);
    return repository;
  }

  async validate(localBasePath: string): Promise<RepositoryValidationResult> {
    try {
      // 1. Validate local path and Git state
      let fullName: string;
      try {
        fullName = await this.git.resolveFullName(localBasePath);
      } catch (err) {
        return { ok: false, error: `Not a git repository or could not resolve full name: ${err}` };
      }

      // 2. Validate GitHub access and metadata
      try {
        const [owner, name] = fullName.split('/');
        if (!owner || !name) throw new Error(`Invalid full name: ${fullName}`);

        const repoInfo = await this.github.getRepo(fullName);

        return {
          ok: true,
          metadata: {
            fullName,
            owner: repoInfo.owner,
            name: repoInfo.name,
            defaultBranch: repoInfo.defaultBranch,
          },
        };
      } catch (err) {
        return { ok: false, error: `GitHub validation failed: ${err}` };
      }
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}

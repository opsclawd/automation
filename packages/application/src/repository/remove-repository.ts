import {
  type Repository,
  type RepositoryId,
  RepositoryId as mkRepositoryId,
} from '@ai-sdlc/domain';
import type { RepositoryRegistryPort, RunRepositoryPort } from '../ports.js';

export class RemoveRepository {
  constructor(
    private readonly repos: RepositoryRegistryPort,
    private readonly runs: RunRepositoryPort,
  ) {}

  async execute(id: RepositoryId): Promise<void> {
    const repo = this.repos.findById(id);
    if (!repo) {
      throw new Error(`Repository not found: ${id}`);
    }

    const activeRuns = this.runs.listByRepo(id).filter((run) =>
      !['passed', 'failed', 'cancelled'].includes(run.status)
    );

    if (activeRuns.length > 0) {
      throw new Error(`Cannot remove repository ${id}: ${activeRuns.length} active runs depend on it.`);
    }

    this.repos.delete(id);
  }
}

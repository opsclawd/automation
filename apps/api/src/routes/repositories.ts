import type { FastifyInstance } from 'fastify';
import type { Container } from '../compose.js';
import { RepositoryId } from '@ai-sdlc/domain';

export async function repositoriesRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get('/api/repositories', async () => {
    const repos = c.repositoryRepository.list();
    return { repositories: repos };
  });

  app.get<{ Params: { repoId: string } }>('/api/repositories/:repoId', async (req, reply) => {
    const repo = c.repositoryRepository.findById(RepositoryId(req.params.repoId));
    if (!repo) return reply.code(404).send({ error: 'not_found' });
    return { repository: repo };
  });
}

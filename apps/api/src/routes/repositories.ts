import type { FastifyInstance } from 'fastify';
import { RepositoryId } from '@ai-sdlc/domain';
import {
  DuplicateRepositoryError,
  RepositoryHasActiveRunsError,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from '@ai-sdlc/domain';
import type { RegisterRepositoryInput, UpdateRepositoryInput } from '@ai-sdlc/application';
import type { Container } from '../compose.js';

const ID_RE = /^[a-f0-9]{64}$/;
const PATH_RE = /^\//;

function toWire(repo: import('@ai-sdlc/domain').Repository) {
  return {
    id: repo.id,
    fullName: repo.fullName,
    owner: repo.owner,
    name: repo.name,
    localBasePath: repo.localBasePath,
    defaultBranch: repo.defaultBranch,
    remoteUrl: repo.remoteUrl,
    enabled: repo.enabled,
    maxConcurrentRuns: repo.maxConcurrentRuns,
    healthStatus: repo.healthStatus,
    healthError: repo.healthError,
    lastHealthCheckAt: repo.lastHealthCheckAt?.toISOString() ?? null,
    configMetadata: repo.configMetadata,
    createdAt: repo.createdAt.toISOString(),
    updatedAt: repo.updatedAt.toISOString(),
  };
}

export async function registerRepositoriesRoutes(
  app: FastifyInstance,
  c: Container,
): Promise<void> {
  app.get('/api/repositories', async (req) => {
    const includeDisabled = (req.query as { all?: string }).all === '1';
    const repos = c.listRepositories.execute({ includeDisabled });
    return { repositories: repos.map(toWire) };
  });

  app.get<{ Params: { id: string } }>('/api/repositories/:id', async (req, reply) => {
    const { id } = req.params;
    if (!ID_RE.test(id) && !id.includes('/')) {
      reply.code(400);
      return { error: 'id must be a sha256 hex or an owner/name' };
    }
    try {
      const repo = id.includes('/')
        ? c.inspectRepository.executeByFullName(id)
        : c.inspectRepository.executeById(RepositoryId(id));
      return toWire(repo);
    } catch (err) {
      if (err instanceof RepositoryNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.post<{ Body: { localPath?: string; fullName?: string; configMetadata?: string } }>(
    '/api/repositories',
    async (req, reply) => {
      const { localPath, fullName, configMetadata } = req.body ?? {};
      if (!localPath || !PATH_RE.test(localPath)) {
        reply.code(400);
        return { error: 'localPath must be an absolute path' };
      }
      try {
        const input: RegisterRepositoryInput = { localPath };
        if (fullName !== undefined) {
          input.fullName = fullName;
        }
        if (configMetadata !== undefined) {
          input.configMetadata = configMetadata;
        }
        const repo = c.registerRepository.execute(input);
        reply.code(201);
        return toWire(repo);
      } catch (err) {
        if (err instanceof RepositoryValidationError) {
          reply.code(400);
          return { error: err.message };
        }
        if (err instanceof DuplicateRepositoryError) {
          reply.code(409);
          return { error: err.message };
        }
        throw err;
      }
    },
  );

  app.patch<{
    Params: { id: string };
    Body: {
      defaultBranch?: string;
      remoteUrl?: string;
      configMetadata?: string;
      enabled?: boolean;
      maxConcurrentRuns?: number;
    };
  }>('/api/repositories/:id', async (req, reply) => {
    const { id } = req.params;
    if (!ID_RE.test(id) && !id.includes('/')) {
      reply.code(400);
      return { error: 'id must be a sha256 hex or an owner/name' };
    }
    try {
      const repoId = id.includes('/') ? c.inspectRepository.executeByFullName(id).id : id;
      const input: UpdateRepositoryInput = {
        id: RepositoryId(repoId),
      };
      if (req.body?.enabled !== undefined) {
        input.enabled = req.body.enabled;
      }
      if (req.body?.defaultBranch !== undefined) {
        input.defaultBranch = req.body.defaultBranch;
      }
      if (req.body?.remoteUrl !== undefined) {
        input.remoteUrl = req.body.remoteUrl;
      }
      if (req.body?.configMetadata !== undefined) {
        input.configMetadata = req.body.configMetadata;
      }
      if (req.body?.maxConcurrentRuns !== undefined) {
        input.maxConcurrentRuns = req.body.maxConcurrentRuns;
      }
      const repo = c.updateRepository.execute(input);
      return toWire(repo);
    } catch (err) {
      if (err instanceof RepositoryNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof RepositoryValidationError) {
        reply.code(400);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/repositories/:id/refresh', async (req, reply) => {
    const { id } = req.params;
    if (!ID_RE.test(id) && !id.includes('/')) {
      reply.code(400);
      return { error: 'id must be a sha256 hex or an owner/name' };
    }
    try {
      const repoId = id.includes('/') ? c.inspectRepository.executeByFullName(id).id : id;
      return toWire(c.refreshRepository.execute(RepositoryId(repoId)));
    } catch (err) {
      if (err instanceof RepositoryNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof RepositoryValidationError) {
        reply.code(502);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/repositories/:id', async (req, reply) => {
    const { id } = req.params;
    if (!ID_RE.test(id) && !id.includes('/')) {
      reply.code(400);
      return { error: 'id must be a sha256 hex or an owner/name' };
    }
    try {
      const repoId = id.includes('/') ? c.inspectRepository.executeByFullName(id).id : id;
      c.removeRepository.execute(RepositoryId(repoId));
      reply.code(204);
      return null;
    } catch (err) {
      if (err instanceof RepositoryNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof RepositoryHasActiveRunsError) {
        reply.code(409);
        return { error: err.message, activeCount: err.activeCount };
      }
      throw err;
    }
  });
}

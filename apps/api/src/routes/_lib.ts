import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Container } from '../compose.js';
import type { RepositoryId, Run } from '@ai-sdlc/domain';
import type { RepositoryRuntime } from '../repository-runtime-factory.js';
import {
  RepositoryNotFoundError,
  RepositoryNotApprovedError,
  RunRepositoryMismatchError,
  RunRepositoryMissingError,
} from '@ai-sdlc/domain';

export type ResolvedRepoContext = {
  repositoryId?: RepositoryId;
  fullName?: string;
};

export function resolveRepoContext(
  req: { headers: Record<string, string | string[] | undefined>; query: Record<string, unknown> },
  container: { repoFullName?: string },
  options?: { allowFallback?: boolean },
): ResolvedRepoContext {
  const headerVal = req.headers['x-repository-id'];
  const header = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  const rawQuery = req.query.repositoryId ?? req.query.repo;
  const queryVal = (Array.isArray(rawQuery) ? rawQuery[0] : rawQuery) as string | undefined;
  const raw = (header || queryVal || '').trim();
  if (!raw) {
    if (options?.allowFallback === false) {
      return {};
    }
    return container.repoFullName ? { fullName: container.repoFullName } : {};
  }
  if (/^[a-f0-9]{64}$/i.test(raw)) {
    return { repositoryId: raw.toLowerCase() as RepositoryId };
  }
  return { fullName: raw };
}

/**
 * Resolve a ResolvedRepoContext to a canonical RepositoryId by looking up
 * `fullName` via the registry. Returns the canonical id on success, throws
 * `RepositoryNotFoundError` if neither `repositoryId` nor `fullName` resolves.
 */
export function canonicalizeRepoContext(
  ctx: ResolvedRepoContext,
  container: { inspectRepository: { executeByFullName(fullName: string): { id: RepositoryId } } },
): RepositoryId {
  if (ctx.repositoryId) return ctx.repositoryId;
  if (ctx.fullName) {
    try {
      return container.inspectRepository.executeByFullName(ctx.fullName).id;
    } catch (err) {
      if (err instanceof RepositoryNotFoundError) throw err;
      throw err;
    }
  }
  throw new RepositoryNotFoundError('<none>');
}

export async function guardRead(
  req: FastifyRequest<{ Params: { runId?: string; uuid?: string } }>,
  reply: FastifyReply,
  c: Container,
): Promise<{ run: Run; runtime?: RepositoryRuntime } | null> {
  const runId = req.params.runId ?? req.params.uuid;
  if (!runId) {
    reply.code(400).send({ error: 'invalid_id' });
    return null;
  }
  const ctx = resolveRepoContext(
    { headers: req.headers, query: (req.query ?? {}) as Record<string, unknown> },
    c,
  );
  let resolvedRepoId: RepositoryId | undefined;
  if (ctx.repositoryId || ctx.fullName) {
    try {
      resolvedRepoId = canonicalizeRepoContext(ctx, c);
    } catch (err) {
      if (err instanceof RepositoryNotFoundError) {
        reply.code(404).send({ error: 'not_found' });
        return null;
      }
      throw err;
    }
  }
  let run: Run | undefined;
  let runtime: RepositoryRuntime | undefined;
  if (c.runtimeCatalog) {
    try {
      const catalogResult = await c.runtimeCatalog.findRun(
        runId as import('@ai-sdlc/domain').RunId,
        resolvedRepoId,
      );
      if (catalogResult) {
        run = catalogResult.run;
        runtime = catalogResult.runtime;
      }
    } catch {
      // Fall through to root repository lookup
    }
  }
  if (!run && c.runRepository) {
    run = c.runRepository.findByUuid(runId);
  }
  if (!run) {
    reply.code(404).send({ error: 'not_found' });
    return null;
  }
  try {
    c.loadRepositoryForRun.execute({
      run,
      ...(resolvedRepoId ? { callerRepoId: resolvedRepoId } : {}),
      strictMatch: false,
    });
  } catch (err) {
    if (err instanceof RunRepositoryMismatchError) {
      reply.code(404).send({ error: 'not_found' });
      return null;
    }
    if (err instanceof RunRepositoryMissingError) {
      reply.code(409).send({ error: 'repository_missing' });
      return null;
    }
    if (err instanceof RepositoryNotApprovedError) {
      reply.code(409).send({ error: 'denied', message: err.message });
      return null;
    }
    throw err;
  }
  return runtime ? { run, runtime } : { run };
}

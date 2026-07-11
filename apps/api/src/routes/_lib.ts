import type { RepositoryId } from '@ai-sdlc/domain';
import { RepositoryNotFoundError } from '@ai-sdlc/domain';

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
  const queryVal = (req.query.repositoryId ?? req.query.repo) as string | undefined;
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

import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type { Artifact, ArtifactStore, WriteArtifactInput } from '@ai-sdlc/application/ports';
import {
  ArtifactNotFoundError,
  CANONICAL_DELIVERABLE_KEYS,
  getHydratedWorktreePath,
  isCanonicalDeliverableKey,
} from '@ai-sdlc/application/ports';

interface FilesystemArtifactStoreOptions {
  durableRoot: string;
  worktreeRoot: string;
}

class InvalidArtifactPathError extends Error {
  constructor(
    public readonly relativePath: string,
    reason: string,
  ) {
    super(`invalid artifact path '${relativePath}': ${reason}`);
    this.name = 'InvalidArtifactPathError';
  }
}

export function createFilesystemArtifactStore(
  options: FilesystemArtifactStoreOptions,
): ArtifactStore {
  const durableRoot = resolve(options.durableRoot);
  const worktreeRoot = resolve(options.worktreeRoot);

  return {
    async write(input: WriteArtifactInput): Promise<Artifact> {
      if (input.contents.includes('\0')) {
        throw new Error('binary files are not supported');
      }

      const normalizedPath = normalizeSafeRelativePath(input.relativePath);
      const durablePath = await resolveArtifactPath(
        durableRoot,
        normalizedPath,
        input.relativePath,
      );
      const worktreePath = await resolveArtifactPath(
        worktreeRoot,
        getHydratedWorktreePath(normalizedPath),
        input.relativePath,
      );

      await assertFileTarget(durablePath, input.relativePath);
      await assertFileTarget(worktreePath, input.relativePath);

      await mkdir(dirname(durablePath), { recursive: true });
      await mkdir(dirname(worktreePath), { recursive: true });

      await writeFile(durablePath, input.contents, 'utf8');
      await writeFile(worktreePath, input.contents, 'utf8');

      return await artifactFromPath({
        runId: input.runId,
        ...(input.phaseId ? { phaseId: input.phaseId } : {}),
        relativePath: normalizedPath,
        absolutePath: durablePath,
      });
    },

    async read(runId: string, relativePath: string): Promise<string> {
      const normalizedPath = normalizeSafeRelativePath(relativePath);
      const durablePath = await resolveArtifactPath(durableRoot, normalizedPath, relativePath);
      const durableContents = await readFileIfPresent(durablePath, relativePath);
      if (durableContents !== undefined) {
        return durableContents;
      }

      const hydratedRelativePath = getHydratedWorktreePath(normalizedPath);
      const hydratedWorktreePath = await resolveArtifactPath(
        worktreeRoot,
        hydratedRelativePath,
        relativePath,
      );
      const hydratedContents = await readFileIfPresent(hydratedWorktreePath, relativePath);
      if (hydratedContents !== undefined) {
        return hydratedContents;
      }

      if (isCanonicalDeliverableKey(normalizedPath)) {
        const legacyWorktreePath = await resolveArtifactPath(
          worktreeRoot,
          normalizedPath,
          relativePath,
        );
        const legacyContents = await readFileIfPresent(legacyWorktreePath, relativePath);
        if (legacyContents !== undefined) {
          return legacyContents;
        }
      }

      throw new ArtifactNotFoundError(runId, relativePath);
    },

    async list(runId: string): Promise<Artifact[]> {
      // List only from the durable root — it contains only written artifacts.
      // Walking worktreeRoot would enumerate the entire repo checkout (source
      // files, node_modules, build outputs) and pollute artifact presence.
      const artifacts = await listRootArtifacts(durableRoot, runId);
      return artifacts.sort((left, right) =>
        left.relativePath < right.relativePath
          ? -1
          : left.relativePath > right.relativePath
            ? 1
            : 0,
      );
    },

    async hydrateWorktree(runId: string): Promise<void> {
      const [resolveDurablePath, resolveWorktreePath] = await Promise.all([
        createArtifactPathResolver(durableRoot),
        createArtifactPathResolver(worktreeRoot),
      ]);

      // Migrate legacy root deliverables before durable hydration. This loop is
      // the sole owner of legacy cleanup so every conflict follows one policy.
      for (const key of CANONICAL_DELIVERABLE_KEYS) {
        const rootPath = await resolveWorktreePath(key, key);
        const rootStat = await statIfPresent(rootPath);
        if (!rootStat) {
          continue;
        }

        if (!rootStat.isFile()) {
          throw new InvalidArtifactPathError(
            key,
            'legacy deliverable at root is not a regular file',
          );
        }

        const destRelativePath = getHydratedWorktreePath(key);
        const destPath = await resolveWorktreePath(destRelativePath, key);
        const destStat = await statIfPresent(destPath);

        if (!destStat) {
          await mkdir(dirname(destPath), { recursive: true });
          await rename(rootPath, destPath);
        } else {
          if (!destStat.isFile()) {
            throw new InvalidArtifactPathError(
              destRelativePath,
              'destination deliverable path is not a regular file',
            );
          }

          if (await filesHaveSameContents(rootPath, rootStat, destPath, destStat)) {
            await unlink(rootPath);
          } else {
            // Canonical deliverables are normalized at the durable root. A
            // stray durable `.ai/<key>` is not an authoritative copy.
            const durableKeyPath = await resolveDurablePath(key, key);
            const durableKeyStat = await statIfPresent(durableKeyPath);

            if (durableKeyStat?.isFile()) {
              await unlink(rootPath);
            } else {
              throw new Error(
                `Conflict hydrating deliverable '${key}': legacy root '${rootPath}' and destination '${destPath}' have differing content and no durable copy exists`,
              );
            }
          }
        }
      }

      const artifacts = await listRootArtifacts(durableRoot, runId);
      for (const artifact of artifacts) {
        const normalizedPath = normalizeSafeRelativePath(artifact.relativePath);
        const worktreeRelativePath = getHydratedWorktreePath(normalizedPath);
        const worktreePath = await resolveWorktreePath(worktreeRelativePath, artifact.relativePath);
        const worktreeStat = await statIfPresent(worktreePath);

        if (worktreeStat?.isDirectory()) {
          throw new InvalidArtifactPathError(worktreeRelativePath, 'path points to a directory');
        }

        const alreadyHydrated =
          worktreeStat !== undefined &&
          (await filesHaveSameContents(
            artifact.absolutePath,
            artifact.bytes,
            worktreePath,
            worktreeStat,
          ));
        if (!alreadyHydrated) {
          await mkdir(dirname(worktreePath), { recursive: true });
          await copyFile(artifact.absolutePath, worktreePath);
        }
      }
    },
  };
}

function normalizeSafeRelativePath(relativePath: string): string {
  if (relativePath.trim() === '') {
    throw new InvalidArtifactPathError(relativePath, 'path must not be empty');
  }

  // Normalize backslashes to forward slashes first to prevent escape bypasses
  const posixPath = relativePath.replace(/\\/g, '/');

  if (isAbsolute(posixPath)) {
    throw new InvalidArtifactPathError(relativePath, 'absolute paths are not allowed');
  }

  const normalizedPath = normalize(posixPath);
  if (normalizedPath === '.' || normalizedPath === '') {
    throw new InvalidArtifactPathError(relativePath, 'path must not resolve to the root');
  }

  const posixNormalized = normalizedPath.replace(/\\/g, '/');
  const segments = posixNormalized.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new InvalidArtifactPathError(relativePath, 'path may not escape the artifact root');
  }

  return posixNormalized;
}

async function resolveArtifactPath(
  root: string,
  normalizedPath: string,
  relativePath: string,
): Promise<string> {
  const resolveFromRoot = await createArtifactPathResolver(root);
  return await resolveFromRoot(normalizedPath, relativePath);
}

async function createArtifactPathResolver(
  root: string,
): Promise<(normalizedPath: string, relativePath: string) => Promise<string>> {
  const rootAbs = resolve(root);
  await mkdir(rootAbs, { recursive: true });
  const canonicalRoot = await realpath(rootAbs);

  return async (normalizedPath: string, relativePath: string): Promise<string> => {
    const targetAbs = resolve(rootAbs, normalizedPath);
    const rel = relative(rootAbs, targetAbs);
    const insideRoot = targetAbs === rootAbs || (!isAbsolute(rel) && rel.split(sep)[0] !== '..');
    if (!insideRoot) {
      throw new InvalidArtifactPathError(relativePath, 'path may not escape the artifact root');
    }

    const canonicalTarget = await getExistingCanonicalPath(targetAbs);
    const isInside =
      canonicalTarget === canonicalRoot || canonicalTarget.startsWith(canonicalRoot + sep);
    if (!isInside) {
      throw new InvalidArtifactPathError(relativePath, 'path may not escape the artifact root');
    }

    return targetAbs;
  };
}

async function filesHaveSameContents(
  leftPath: string,
  leftStat: Stats | number,
  rightPath: string,
  rightStat: Stats | number,
): Promise<boolean> {
  const leftSize = typeof leftStat === 'number' ? leftStat : Number(leftStat.size);
  const rightSize = typeof rightStat === 'number' ? rightStat : Number(rightStat.size);
  if (leftSize !== rightSize) {
    return false;
  }

  const [leftHash, rightHash] = await Promise.all([hashFile(leftPath), hashFile(rightPath)]);
  return leftHash === rightHash;
}

async function hashFile(absolutePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absolutePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function getExistingCanonicalPath(path: string): Promise<string> {
  let current = path;
  while (true) {
    try {
      return await realpath(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const parent = dirname(current);
        if (parent === current) {
          throw err;
        }
        current = parent;
      } else {
        throw err;
      }
    }
  }
}

async function assertFileTarget(absolutePath: string, relativePath: string): Promise<void> {
  const fileStat = await statIfPresent(absolutePath);
  if (fileStat?.isDirectory()) {
    throw new InvalidArtifactPathError(relativePath, 'path points to a directory');
  }
}

async function statIfPresent(absolutePath: string): Promise<Stats | undefined> {
  try {
    return await stat(absolutePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

async function readFileIfPresent(
  absolutePath: string,
  relativePath: string,
): Promise<string | undefined> {
  const fileStat = await statIfPresent(absolutePath);
  if (!fileStat) {
    return undefined;
  }
  if (fileStat.isDirectory()) {
    throw new InvalidArtifactPathError(relativePath, 'path points to a directory');
  }

  try {
    return await readFile(absolutePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

async function listRootArtifacts(root: string, runId: string): Promise<Artifact[]> {
  try {
    await access(root);
  } catch {
    return [];
  }

  const results: Artifact[] = [];
  const stack = [''];

  while (stack.length > 0) {
    const currentRelativeDir = stack.pop()!;
    const currentAbsoluteDir = currentRelativeDir === '' ? root : join(root, currentRelativeDir);
    const entries = await readdir(currentAbsoluteDir, { withFileTypes: true });

    for (const entry of entries) {
      const relativePathRaw =
        currentRelativeDir === '' ? entry.name : join(currentRelativeDir, entry.name);
      const relativePath = relativePathRaw.replace(/\\/g, '/');
      const absolutePath = join(root, relativePathRaw);

      if (entry.isDirectory()) {
        stack.push(relativePathRaw);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const fileStat = await statIfPresent(absolutePath);
      if (!fileStat) {
        continue;
      }

      results.push(
        await artifactFromPath(
          {
            runId,
            relativePath,
            absolutePath,
          },
          fileStat,
        ),
      );
    }
  }

  return results;
}

async function artifactFromPath(
  input: {
    runId: string;
    phaseId?: string;
    relativePath: string;
    absolutePath: string;
  },
  statObj?: Stats,
): Promise<Artifact> {
  const fileStat = statObj ?? (await stat(input.absolutePath));
  return {
    runId: input.runId,
    ...(input.phaseId ? { phaseId: input.phaseId } : {}),
    relativePath: input.relativePath,
    absolutePath: input.absolutePath,
    bytes: Number(fileStat.size),
    createdAt: new Date(Number(fileStat.birthtimeMs > 0 ? fileStat.birthtimeMs : fileStat.mtimeMs)),
  };
}

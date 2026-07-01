import { type Stats } from 'node:fs';
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type { Artifact, ArtifactStore, WriteArtifactInput } from '@ai-sdlc/application/ports';
import { ArtifactNotFoundError } from '@ai-sdlc/application/ports';

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
      const normalizedPath = normalizeSafeRelativePath(input.relativePath);
      const durablePath = resolveArtifactPath(durableRoot, normalizedPath);
      const worktreePath = resolveArtifactPath(worktreeRoot, normalizedPath);

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
      const durablePath = resolveArtifactPath(durableRoot, normalizedPath);
      const worktreePath = resolveArtifactPath(worktreeRoot, normalizedPath);

      await assertReadTarget(durablePath, relativePath);
      await assertReadTarget(worktreePath, relativePath);

      const durableContents = await readFileIfPresent(durablePath, relativePath);
      if (durableContents !== undefined) {
        return durableContents;
      }

      const worktreeContents = await readFileIfPresent(worktreePath, relativePath);
      if (worktreeContents !== undefined) {
        return worktreeContents;
      }

      throw new ArtifactNotFoundError(runId, relativePath);
    },

    async list(runId: string): Promise<Artifact[]> {
      const artifacts = new Map<string, Artifact>();

      const [durableArtifacts, worktreeArtifacts] = await Promise.all([
        listRootArtifacts(durableRoot, runId),
        listRootArtifacts(worktreeRoot, runId),
      ]);

      for (const artifact of durableArtifacts) {
        artifacts.set(artifact.relativePath, artifact);
      }
      for (const artifact of worktreeArtifacts) {
        if (!artifacts.has(artifact.relativePath)) {
          artifacts.set(artifact.relativePath, artifact);
        }
      }

      return [...artifacts.values()].sort((left, right) =>
        left.relativePath < right.relativePath
          ? -1
          : left.relativePath > right.relativePath
            ? 1
            : 0,
      );
    },
  };
}

function normalizeSafeRelativePath(relativePath: string): string {
  if (relativePath.trim() === '') {
    throw new InvalidArtifactPathError(relativePath, 'path must not be empty');
  }
  if (isAbsolute(relativePath)) {
    throw new InvalidArtifactPathError(relativePath, 'absolute paths are not allowed');
  }

  const normalizedPath = normalize(relativePath);
  if (normalizedPath === '.' || normalizedPath === '') {
    throw new InvalidArtifactPathError(relativePath, 'path must not resolve to the root');
  }

  const segments = normalizedPath.split(sep);
  if (segments.some((segment) => segment === '..')) {
    throw new InvalidArtifactPathError(relativePath, 'path may not escape the artifact root');
  }

  return normalizedPath.replace(/\\/g, '/');
}

function resolveArtifactPath(root: string, normalizedPath: string): string {
  const rootAbs = resolve(root);
  const targetAbs = resolve(rootAbs, normalizedPath);
  const rel = relative(rootAbs, targetAbs);
  const insideRoot = targetAbs === rootAbs || (!isAbsolute(rel) && rel.split(sep)[0] !== '..');
  if (!insideRoot) {
    throw new InvalidArtifactPathError(normalizedPath, 'path may not escape the artifact root');
  }
  return targetAbs;
}

async function assertFileTarget(absolutePath: string, relativePath: string): Promise<void> {
  const fileStat = await statIfPresent(absolutePath);
  if (fileStat?.isDirectory()) {
    throw new InvalidArtifactPathError(relativePath, 'path points to a directory');
  }
}

async function assertReadTarget(absolutePath: string, relativePath: string): Promise<void> {
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

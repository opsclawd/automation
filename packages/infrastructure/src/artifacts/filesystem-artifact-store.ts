import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  type Stats,
  statSync,
  writeFileSync,
} from 'node:fs';
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

      assertFileTarget(durablePath, input.relativePath);
      assertFileTarget(worktreePath, input.relativePath);

      mkdirSync(dirname(durablePath), { recursive: true });
      mkdirSync(dirname(worktreePath), { recursive: true });

      writeFileSync(durablePath, input.contents, 'utf8');
      writeFileSync(worktreePath, input.contents, 'utf8');

      return artifactFromPath({
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

      assertReadTarget(durablePath, relativePath);
      assertReadTarget(worktreePath, relativePath);

      const durableContents = readFileIfPresent(durablePath, relativePath);
      if (durableContents !== undefined) {
        return durableContents;
      }

      const worktreeContents = readFileIfPresent(worktreePath, relativePath);
      if (worktreeContents !== undefined) {
        return worktreeContents;
      }

      throw new ArtifactNotFoundError(runId, relativePath);
    },

    async list(runId: string): Promise<Artifact[]> {
      const artifacts = new Map<string, Artifact>();

      for (const artifact of listRootArtifacts(durableRoot, runId)) {
        artifacts.set(artifact.relativePath, artifact);
      }
      for (const artifact of listRootArtifacts(worktreeRoot, runId)) {
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

  return normalizedPath;
}

function resolveArtifactPath(root: string, normalizedPath: string): string {
  const rootAbs = resolve(root);
  const targetAbs = resolve(rootAbs, normalizedPath);
  const insideRoot = targetAbs === rootAbs || relative(rootAbs, targetAbs).split(sep)[0] !== '..';
  if (!insideRoot) {
    throw new InvalidArtifactPathError(normalizedPath, 'path may not escape the artifact root');
  }
  return targetAbs;
}

function assertFileTarget(absolutePath: string, relativePath: string): void {
  const stat = statIfPresent(absolutePath);
  if (stat?.isDirectory()) {
    throw new InvalidArtifactPathError(relativePath, 'path points to a directory');
  }
}

function assertReadTarget(absolutePath: string, relativePath: string): void {
  const stat = statIfPresent(absolutePath);
  if (stat?.isDirectory()) {
    throw new InvalidArtifactPathError(relativePath, 'path points to a directory');
  }
}

function statIfPresent(absolutePath: string) {
  try {
    return statSync(absolutePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

function readFileIfPresent(absolutePath: string, relativePath: string): string | undefined {
  const stat = statIfPresent(absolutePath);
  if (!stat) {
    return undefined;
  }
  if (stat.isDirectory()) {
    throw new InvalidArtifactPathError(relativePath, 'path points to a directory');
  }

  try {
    return readFileSync(absolutePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

function listRootArtifacts(root: string, runId: string): Artifact[] {
  if (!existsSync(root)) {
    return [];
  }

  const results: Artifact[] = [];
  const stack = [''];

  while (stack.length > 0) {
    const currentRelativeDir = stack.pop()!;
    const currentAbsoluteDir = currentRelativeDir === '' ? root : join(root, currentRelativeDir);
    const entries = readdirSync(currentAbsoluteDir, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath =
        currentRelativeDir === '' ? entry.name : join(currentRelativeDir, entry.name);
      const absolutePath = join(root, relativePath);

      if (entry.isDirectory()) {
        stack.push(relativePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const stat = statIfPresent(absolutePath);
      if (!stat) {
        continue;
      }

      results.push(
        artifactFromPath(
          {
            runId,
            relativePath,
            absolutePath,
          },
          stat,
        ),
      );
    }
  }

  return results;
}

function artifactFromPath(
  input: {
    runId: string;
    phaseId?: string;
    relativePath: string;
    absolutePath: string;
  },
  stat?: Stats,
): Artifact {
  const fileStat = stat ?? statSync(input.absolutePath);
  return {
    runId: input.runId,
    ...(input.phaseId ? { phaseId: input.phaseId } : {}),
    relativePath: input.relativePath,
    absolutePath: input.absolutePath,
    bytes: Number(fileStat.size),
    createdAt: new Date(Number(fileStat.birthtimeMs > 0 ? fileStat.birthtimeMs : fileStat.mtimeMs)),
  };
}

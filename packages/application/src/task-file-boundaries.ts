import { isOrchestratorArtifactPattern } from './artifacts/orchestrator-artifacts.js';

export interface TaskBoundaryClassification {
  modifiedReferenceFiles: string[];
  undeclaredFiles: string[];
}

export function normalizeTaskPath(path: unknown): string {
  if (typeof path !== 'string') return '';
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/|\/)+/, '');
}

export function declaredTaskFiles(task: unknown): string[] {
  if (!task || typeof task !== 'object') return [];
  const record = task as Record<string, unknown>;
  const expectedFiles = Array.isArray(record.expected_files) ? record.expected_files : [];
  const files = Array.isArray(record.files) ? record.files : [];

  const requiredExpectedFiles = expectedFiles.map(normalizeTaskPath).filter(Boolean);
  const requiredLegacyFiles = files.map(normalizeTaskPath).filter(Boolean);
  return [...new Set([...requiredExpectedFiles, ...requiredLegacyFiles])];
}

export function referenceTaskFiles(task: unknown): string[] {
  if (!task || typeof task !== 'object') return [];
  const referenceFiles = (task as Record<string, unknown>).reference_files;
  if (!Array.isArray(referenceFiles)) return [];
  return [...new Set(referenceFiles.map(normalizeTaskPath).filter(Boolean))];
}

export function normalizedPathSet(paths: readonly string[] | undefined): Set<string> {
  return new Set((paths ?? []).map(normalizeTaskPath).filter(Boolean));
}

export function hasDeclaredSurface(task: unknown, manifestVersion?: number): boolean {
  if (!task || typeof task !== 'object') return false;
  const record = task as Record<string, unknown>;
  const expectedFiles = Array.isArray(record.expected_files) ? record.expected_files : undefined;
  const referenceFiles = Array.isArray(record.reference_files) ? record.reference_files : undefined;
  const files = Array.isArray(record.files) ? record.files : undefined;
  if (manifestVersion === 2) {
    return expectedFiles !== undefined || referenceFiles !== undefined || files !== undefined;
  }
  return (
    (expectedFiles !== undefined && expectedFiles.length > 0) ||
    (files !== undefined && files.length > 0)
  );
}

export function classifyUndeclaredFiles(
  committedFiles: readonly string[],
  writableFiles: ReadonlySet<string>,
  referenceFiles: ReadonlySet<string>,
  exemptFiles: ReadonlySet<string>,
): TaskBoundaryClassification {
  const undeclared = [...new Set(committedFiles.map(normalizeTaskPath).filter(Boolean))]
    .filter(
      (file) =>
        !writableFiles.has(file) &&
        !exemptFiles.has(file) &&
        !isOrchestratorArtifactPattern(file),
    )
    .sort();
  return {
    modifiedReferenceFiles: undeclared.filter((file) => referenceFiles.has(file)),
    undeclaredFiles: undeclared.filter((file) => !referenceFiles.has(file)),
  };
}

export function getManifestBoundaries(manifest: unknown): {
  writableSet: Set<string>;
  referenceSet: Set<string>;
} {
  if (!manifest || typeof manifest !== 'object') {
    return { writableSet: new Set(), referenceSet: new Set() };
  }
  const record = manifest as Record<string, unknown>;
  const tasks = Array.isArray(record.tasks) ? record.tasks : [];
  const writableFiles = tasks.flatMap((t) => declaredTaskFiles(t));
  const referenceFiles = tasks.flatMap((t) => referenceTaskFiles(t));
  return {
    writableSet: normalizedPathSet(writableFiles),
    referenceSet: normalizedPathSet(referenceFiles),
  };
}

export function checkTaskBoundaries(
  committedFiles: readonly string[],
  manifest: unknown,
  exemptFiles?: readonly string[],
): TaskBoundaryClassification {
  const { writableSet, referenceSet } = getManifestBoundaries(manifest);
  const exemptSet = normalizedPathSet(exemptFiles);
  return classifyUndeclaredFiles(committedFiles, writableSet, referenceSet, exemptSet);
}

export type ManifestLoadResult =
  | { status: 'found'; manifest: unknown }
  | { status: 'missing'; message: string }
  | { status: 'malformed'; message: string; error: string };

function isNotFoundError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('not found') ||
      msg.includes('enoent') ||
      msg.includes('file does not exist') ||
      msg.includes('missing') ||
      msg.includes('no such file')
    );
  }
  const errStr = String(err).toLowerCase();
  return (
    errStr.includes('not found') ||
    errStr.includes('enoent') ||
    errStr.includes('file does not exist') ||
    errStr.includes('missing') ||
    errStr.includes('no such file')
  );
}

export async function loadManifest(
  input: { manifest?: unknown; runId?: unknown },
  ctx: { cwd: string; runId?: unknown },
  deps?: {
    artifactStore?: { read: (runId: string, relativePath: string) => Promise<string> } | undefined;
    readWorktreeFile?:
      | ((cwd: string, relativePath: string) => Promise<string | undefined>)
      | undefined;
  },
): Promise<ManifestLoadResult> {
  if (input.manifest) {
    if (
      typeof input.manifest === 'object' &&
      input.manifest !== null &&
      'tasks' in input.manifest
    ) {
      return { status: 'found', manifest: input.manifest };
    }
    return {
      status: 'malformed',
      message: 'input manifest is invalid',
      error: 'manifest must be an object with a tasks property',
    };
  }

  const runId = input.runId !== undefined && input.runId !== null ? String(input.runId) : undefined;

  if (deps?.artifactStore && runId !== undefined) {
    try {
      const raw = await deps.artifactStore.read(runId, 'task-manifest.json');
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) {
          return { status: 'found', manifest: parsed };
        }
        return {
          status: 'malformed',
          message: 'task-manifest.json in artifact store is not an object',
          error: 'parsed to non-object',
        };
      } catch (parseErr) {
        const errStr = parseErr instanceof Error ? parseErr.message : String(parseErr);
        return {
          status: 'malformed',
          message: `malformed task-manifest.json in artifact store: ${errStr}`,
          error: errStr,
        };
      }
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw err;
      }
    }
  }

  if (deps?.readWorktreeFile) {
    try {
      const raw = await deps.readWorktreeFile(ctx.cwd, 'task-manifest.json');
      if (raw !== undefined && raw !== null && raw !== '') {
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed === 'object' && parsed !== null) {
            return { status: 'found', manifest: parsed };
          }
          return {
            status: 'malformed',
            message: 'task-manifest.json in worktree is not an object',
            error: 'parsed to non-object',
          };
        } catch (parseErr) {
          const errStr = parseErr instanceof Error ? parseErr.message : String(parseErr);
          return {
            status: 'malformed',
            message: `malformed task-manifest.json in worktree: ${errStr}`,
            error: errStr,
          };
        }
      }
    } catch {
      // not found in worktree
    }
  }

  return { status: 'missing', message: 'task-manifest.json not found' };
}

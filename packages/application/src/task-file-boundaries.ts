import { isOrchestratorArtifactPattern } from './artifacts/orchestrator-artifacts.js';

export interface TaskBoundaryClassification {
  modifiedReferenceFiles: string[];
  undeclaredFiles: string[];
}

export interface EffectiveTaskScope {
  requiredFiles: string[];
  mayExtendFiles: string[];
  permittedAreas: string[];
  nonGoals: string[];
  referenceFiles: string[];
}

export function normalizeTaskPath(path: unknown): string {
  if (typeof path !== 'string') return '';
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/|\/)+/, '');
}

export function resolveEffectiveTaskScope(task: unknown): EffectiveTaskScope {
  if (!task || typeof task !== 'object') {
    return {
      requiredFiles: [],
      mayExtendFiles: [],
      permittedAreas: [],
      nonGoals: [],
      referenceFiles: [],
    };
  }
  const record = task as Record<string, unknown>;
  const expectedFiles = Array.isArray(record.expected_files) ? record.expected_files : [];
  const files = Array.isArray(record.files) ? record.files : [];
  const mayExtend = Array.isArray(record.may_extend) ? record.may_extend : [];
  const permittedAreas = Array.isArray(record.permitted_areas) ? record.permitted_areas : [];
  const nonGoals = Array.isArray(record.non_goals) ? record.non_goals : [];
  const referenceFiles = Array.isArray(record.reference_files) ? record.reference_files : [];

  const required = [
    ...new Set(
      [...expectedFiles.map(normalizeTaskPath), ...files.map(normalizeTaskPath)].filter(Boolean),
    ),
  ];
  const mayExtendList = [...new Set(mayExtend.map(normalizeTaskPath).filter(Boolean))];
  const nonGoalsList = [...new Set(nonGoals.map(normalizeTaskPath).filter(Boolean))];
  const referenceList = [...new Set(referenceFiles.map(normalizeTaskPath).filter(Boolean))];

  const derivedAreas: string[] = [];
  for (const file of required) {
    const lastSlash = file.lastIndexOf('/');
    if (lastSlash > 0) {
      const parent = file.slice(0, lastSlash);
      if (parent.length > 0 && parent !== '.') {
        derivedAreas.push(parent);
      }
    }
  }

  const explicitAreas = permittedAreas.map(normalizeTaskPath).filter(Boolean);
  const permitted = [...new Set([...derivedAreas, ...explicitAreas])];

  return {
    requiredFiles: required,
    mayExtendFiles: mayExtendList,
    permittedAreas: permitted,
    nonGoals: nonGoalsList,
    referenceFiles: referenceList,
  };
}

export function declaredTaskFiles(task: unknown): string[] {
  return resolveEffectiveTaskScope(task).requiredFiles;
}

export function referenceTaskFiles(task: unknown): string[] {
  return resolveEffectiveTaskScope(task).referenceFiles;
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
  const mayExtend = Array.isArray(record.may_extend) ? record.may_extend : undefined;
  const permittedAreas = Array.isArray(record.permitted_areas) ? record.permitted_areas : undefined;
  if (manifestVersion === 2) {
    return (
      expectedFiles !== undefined ||
      (referenceFiles !== undefined && referenceFiles.length > 0) ||
      (files !== undefined && files.length > 0) ||
      (mayExtend !== undefined && mayExtend.length > 0) ||
      (permittedAreas !== undefined && permittedAreas.length > 0)
    );
  }
  return (
    (expectedFiles !== undefined && expectedFiles.length > 0) ||
    (files !== undefined && files.length > 0)
  );
}

export function isPathPermittedByScope(filePath: string, scope: EffectiveTaskScope): boolean {
  const norm = normalizeTaskPath(filePath);
  if (!norm) return false;

  if (scope.nonGoals.some((ng) => norm === ng || norm.startsWith(ng + '/'))) {
    return false;
  }

  if (scope.referenceFiles.includes(norm)) {
    return false;
  }

  if (scope.requiredFiles.includes(norm) || scope.mayExtendFiles.includes(norm)) {
    return true;
  }

  if (scope.permittedAreas.some((area) => norm === area || norm.startsWith(area + '/'))) {
    return true;
  }

  return false;
}

/**
 * @deprecated Legacy V1 boundary classifier. Ignores V2 permitted_areas and non_goals.
 * Use {@link checkTaskBoundaries} instead to validate file changes against full V1/V2 scopes.
 */
export function classifyUndeclaredFiles(
  committedFiles: readonly string[],
  writableFiles: ReadonlySet<string>,
  referenceFiles: ReadonlySet<string>,
  exemptFiles: ReadonlySet<string>,
): TaskBoundaryClassification {
  const undeclared = [...new Set(committedFiles.map(normalizeTaskPath).filter(Boolean))]
    .filter(
      (file) =>
        !writableFiles.has(file) && !exemptFiles.has(file) && !isOrchestratorArtifactPattern(file),
    )
    .sort();
  return {
    modifiedReferenceFiles: undeclared.filter((file) => referenceFiles.has(file)),
    undeclaredFiles: undeclared.filter((file) => !referenceFiles.has(file)),
  };
}

/**
 * @deprecated Legacy V1 boundary helper. Ignores V2 permitted_areas and non_goals.
 * Use {@link checkTaskBoundaries} or {@link resolveEffectiveTaskScope} instead.
 */
export function getManifestBoundaries(manifest: unknown): {
  writableSet: Set<string>;
  referenceSet: Set<string>;
} {
  if (!manifest || typeof manifest !== 'object') {
    return { writableSet: new Set(), referenceSet: new Set() };
  }
  const record = manifest as Record<string, unknown>;
  const tasks = Array.isArray(record.tasks) ? record.tasks : [];
  const writableFiles: string[] = [];
  const referenceFiles: string[] = [];
  for (const task of tasks) {
    const scope = resolveEffectiveTaskScope(task);
    writableFiles.push(...scope.requiredFiles, ...scope.mayExtendFiles);
    referenceFiles.push(...scope.referenceFiles);
  }
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
  const exemptSet = normalizedPathSet(exemptFiles);
  const normalizedCandidates = [
    ...new Set(committedFiles.map(normalizeTaskPath).filter(Boolean)),
  ].filter((file) => !exemptSet.has(file) && !isOrchestratorArtifactPattern(file));

  if (!manifest || typeof manifest !== 'object') {
    return {
      modifiedReferenceFiles: [],
      undeclaredFiles: normalizedCandidates.sort(),
    };
  }

  const record = manifest as Record<string, unknown>;
  const tasks = Array.isArray(record.tasks) ? record.tasks : [];
  const scopes = tasks.map((t) => resolveEffectiveTaskScope(t));
  const referenceFilesSet = new Set(scopes.flatMap((s) => s.referenceFiles));

  const modifiedReferenceFiles: string[] = [];
  const undeclaredFiles: string[] = [];

  for (const file of normalizedCandidates) {
    const isPermitted = scopes.some((scope) => isPathPermittedByScope(file, scope));
    if (!isPermitted) {
      if (referenceFilesSet.has(file)) {
        modifiedReferenceFiles.push(file);
      } else {
        undeclaredFiles.push(file);
      }
    }
  }

  return {
    modifiedReferenceFiles: [...new Set(modifiedReferenceFiles)].sort(),
    undeclaredFiles: [...new Set(undeclaredFiles)].sort(),
  };
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
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw err;
      }
    }
  }

  return { status: 'missing', message: 'task-manifest.json not found' };
}

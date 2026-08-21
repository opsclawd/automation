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

export interface TaskChangeCandidate {
  path: string;
  tracked?: boolean;
}

export interface PrematureImplementationRecord {
  path: string;
  taskNumber: number;
}

export interface TaskScopeClassification {
  permittedPaths: string[];
  modifiedReferenceFiles: string[];
  nonGoalFiles: string[];
  prematureImplementation: PrematureImplementationRecord[];
  driftFiles: string[];
  protectedFiles?: string[];
}

export interface ClassifyTaskChangesOptions {
  candidates: readonly (string | TaskChangeCandidate)[];
  currentScope: EffectiveTaskScope;
  manifestTasks?: readonly unknown[];
  tasks?: readonly unknown[];
  downstreamTasks?: readonly unknown[];
  manifest?: unknown;
  currentTaskNumber?: number;
  exemptFiles?: readonly string[];
  isProtected?: (path: string) => boolean;
}

function isNormalizedSegmentPrefixMatch(normPrefix: string, normPath: string): boolean {
  if (!normPrefix || !normPath) return false;
  return normPath === normPrefix || normPath.startsWith(normPrefix + '/');
}

export function isSegmentPrefixMatch(prefix: string, path: string): boolean {
  const normPrefix = normalizeTaskPath(prefix);
  const normPath = normalizeTaskPath(path);
  return isNormalizedSegmentPrefixMatch(normPrefix, normPath);
}

export function isProtectedTaskPath(path: string): boolean {
  const norm = normalizeTaskPath(path);
  if (!norm) return false;
  if (
    norm === '.gitignore' ||
    norm === '.ai-orchestrator.json' ||
    norm === '.github' ||
    norm.startsWith('.github/')
  ) {
    return true;
  }
  return isOrchestratorArtifactPattern(norm);
}

function getTaskNumber(task: unknown, fallbackIndex: number): number {
  if (task && typeof task === 'object') {
    const record = task as Record<string, unknown>;
    if (typeof record.n === 'number' && Number.isFinite(record.n)) {
      return record.n;
    }
    if (typeof record.task_number === 'number' && Number.isFinite(record.task_number)) {
      return record.task_number;
    }
  }
  return fallbackIndex + 1;
}

export function classifyTaskChanges(options: ClassifyTaskChangesOptions): TaskScopeClassification;
export function classifyTaskChanges(
  candidates: readonly (string | TaskChangeCandidate)[],
  currentScope: EffectiveTaskScope,
  options?: Partial<Omit<ClassifyTaskChangesOptions, 'candidates' | 'currentScope'>>,
): TaskScopeClassification;
export function classifyTaskChanges(
  first: ClassifyTaskChangesOptions | readonly (string | TaskChangeCandidate)[],
  second?: EffectiveTaskScope,
  third?: Partial<Omit<ClassifyTaskChangesOptions, 'candidates' | 'currentScope'>>,
): TaskScopeClassification {
  let opts: ClassifyTaskChangesOptions;
  if (Array.isArray(first)) {
    opts = {
      candidates: first,
      currentScope: second ?? {
        requiredFiles: [],
        mayExtendFiles: [],
        permittedAreas: [],
        nonGoals: [],
        referenceFiles: [],
      },
      ...third,
    };
  } else {
    opts = first as ClassifyTaskChangesOptions;
  }

  const rawScope = opts.currentScope ?? {
    requiredFiles: [],
    mayExtendFiles: [],
    permittedAreas: [],
    nonGoals: [],
    referenceFiles: [],
  };

  const normNonGoals = (rawScope.nonGoals ?? []).map(normalizeTaskPath).filter(Boolean);
  const normPermittedAreas = (rawScope.permittedAreas ?? []).map(normalizeTaskPath).filter(Boolean);
  const requiredFilesSet = normalizedPathSet(rawScope.requiredFiles);
  const mayExtendFilesSet = normalizedPathSet(rawScope.mayExtendFiles);
  const referenceFilesSet = normalizedPathSet(rawScope.referenceFiles);

  const exemptSet = normalizedPathSet(opts.exemptFiles);
  const isProtectedFn = opts.isProtected ?? isProtectedTaskPath;

  const downstreamRequiredMap = new Map<string, number>();

  if (opts.downstreamTasks) {
    for (let i = 0; i < opts.downstreamTasks.length; i++) {
      const task = opts.downstreamTasks[i];
      const taskNum = getTaskNumber(task, i);
      const scope = resolveEffectiveTaskScope(task);
      for (const reqFile of scope.requiredFiles) {
        if (!downstreamRequiredMap.has(reqFile)) {
          downstreamRequiredMap.set(reqFile, taskNum);
        }
      }
    }
  } else {
    let allTasks: readonly unknown[] = [];
    if (Array.isArray(opts.manifestTasks)) {
      allTasks = opts.manifestTasks;
    } else if (Array.isArray(opts.tasks)) {
      allTasks = opts.tasks;
    } else if (opts.manifest && typeof opts.manifest === 'object') {
      const manifestRecord = opts.manifest as Record<string, unknown>;
      if (Array.isArray(manifestRecord.tasks)) {
        allTasks = manifestRecord.tasks;
      }
    }

    for (let i = 0; i < allTasks.length; i++) {
      const task = allTasks[i];
      const taskNum = getTaskNumber(task, i);
      if (opts.currentTaskNumber !== undefined && taskNum <= opts.currentTaskNumber) {
        continue;
      }
      const scope = resolveEffectiveTaskScope(task);
      for (const reqFile of scope.requiredFiles) {
        if (!downstreamRequiredMap.has(reqFile)) {
          downstreamRequiredMap.set(reqFile, taskNum);
        }
      }
    }
  }

  const normalizedCandidateMap = new Map<string, boolean>();
  for (const rawCandidate of opts.candidates ?? []) {
    const rawPath = typeof rawCandidate === 'string' ? rawCandidate : rawCandidate?.path;
    const norm = normalizeTaskPath(rawPath);
    if (!norm) continue;

    const isTracked = typeof rawCandidate === 'string' ? true : rawCandidate.tracked !== false;
    if (!normalizedCandidateMap.has(norm)) {
      normalizedCandidateMap.set(norm, isTracked);
    } else if (isTracked) {
      normalizedCandidateMap.set(norm, true);
    }
  }

  const protectedFiles: string[] = [];
  const nonGoalFiles: string[] = [];
  const prematureImplementation: PrematureImplementationRecord[] = [];
  const modifiedReferenceFiles: string[] = [];
  const permittedPaths: string[] = [];
  const driftFiles: string[] = [];

  for (const [normPath, tracked] of normalizedCandidateMap.entries()) {
    // 1. Protected check
    if (isProtectedFn(normPath) || isProtectedTaskPath(normPath)) {
      protectedFiles.push(normPath);
      continue;
    }

    // 2. Non-goal check
    if (normNonGoals.some((ng) => isNormalizedSegmentPrefixMatch(ng, normPath))) {
      nonGoalFiles.push(normPath);
      continue;
    }

    // 3. Downstream required file check
    if (downstreamRequiredMap.has(normPath)) {
      prematureImplementation.push({
        path: normPath,
        taskNumber: downstreamRequiredMap.get(normPath)!,
      });
      continue;
    }

    // 4. Reference file check
    if (referenceFilesSet.has(normPath)) {
      if (exemptSet.has(normPath)) {
        continue;
      }
      modifiedReferenceFiles.push(normPath);
      continue;
    }

    // 5. Current required or may_extend check (exact match)
    if (requiredFilesSet.has(normPath) || mayExtendFilesSet.has(normPath)) {
      permittedPaths.push(normPath);
      continue;
    }

    // 6. Permitted area check (tracked only)
    if (normPermittedAreas.some((area) => isNormalizedSegmentPrefixMatch(area, normPath))) {
      if (tracked) {
        permittedPaths.push(normPath);
      } else {
        driftFiles.push(normPath);
      }
      continue;
    }

    // 7. Drift check
    if (exemptSet.has(normPath)) {
      continue;
    }
    driftFiles.push(normPath);
  }

  return {
    permittedPaths: [...new Set(permittedPaths)].sort(),
    modifiedReferenceFiles: [...new Set(modifiedReferenceFiles)].sort(),
    nonGoalFiles: [...new Set(nonGoalFiles)].sort(),
    prematureImplementation: prematureImplementation.sort(
      (a, b) => a.path.localeCompare(b.path) || a.taskNumber - b.taskNumber,
    ),
    driftFiles: [...new Set(driftFiles)].sort(),
    protectedFiles: [...new Set(protectedFiles)].sort(),
  };
}

export function normalizeTaskPath(path: unknown): string {
  if (typeof path !== 'string') return '';
  const trimmed = path.trim();
  if (!trimmed) return '';
  return trimmed
    .replace(/\\/g, '/')
    .replace(/^(\.\/|\/)+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '');
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

  if (scope.nonGoals.some((ng) => isSegmentPrefixMatch(ng, norm))) {
    return false;
  }

  if (scope.referenceFiles.includes(norm)) {
    return false;
  }

  if (scope.requiredFiles.includes(norm) || scope.mayExtendFiles.includes(norm)) {
    return true;
  }

  if (scope.permittedAreas.some((area) => isSegmentPrefixMatch(area, norm))) {
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

  const runIdVal = input.runId ?? ctx.runId;
  const runId = runIdVal !== undefined && runIdVal !== null ? String(runIdVal) : undefined;

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

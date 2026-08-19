import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import {
  isOrchestratorArtifactPattern,
  unquoteGitPath,
} from './artifacts/orchestrator-artifacts.js';
import type { PhaseHandlerContext } from './phases/handler.js';

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

export function isProtectedFilePath(pathStr: string): boolean {
  const norm = normalizeTaskPath(pathStr);
  return norm === '.gitignore' || norm === '.ai-orchestrator.json' || norm.startsWith('.github/');
}

export function undeclaredUntrackedFiles(
  status: string,
  writableFiles: ReadonlySet<string>,
  referenceFiles: ReadonlySet<string>,
  exemptFiles: ReadonlySet<string>,
): string[] {
  const paths = status
    .split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => normalizeTaskPath(unquoteGitPath(line.slice(3))))
    .filter((pathStr) => pathStr.length > 0)
    .filter(
      (pathStr) =>
        !writableFiles.has(pathStr) &&
        !referenceFiles.has(pathStr) &&
        !exemptFiles.has(pathStr) &&
        !isProtectedFilePath(pathStr) &&
        !isOrchestratorArtifactPattern(pathStr),
    );

  return [...new Set(paths)].sort();
}

export const SCRATCH_FILES_ARTIFACT_PATH = '.ai-tmp/scratch-files.json';

export interface ScratchFileStepRecord {
  stepIndex: number;
  totalSteps: number;
  stepTitle: string;
  files: string[];
  phase?: string;
}

export interface ScratchFilesReport {
  steps: ScratchFileStepRecord[];
}

export async function recordScratchFilesReport(
  ctx: PhaseHandlerContext,
  stepIndex: number,
  totalSteps: number,
  stepTitle: string,
  files: string[],
  phaseId: string = 'implement',
): Promise<void> {
  let report: ScratchFilesReport = { steps: [] };
  try {
    let existing: string | undefined;
    try {
      existing = await ctx.artifacts.read(ctx.runUuid, SCRATCH_FILES_ARTIFACT_PATH);
    } catch {
      existing = await ctx.artifacts.read(ctx.runUuid, 'scratch-files.json');
    }
    const parsed = JSON.parse(existing) as ScratchFilesReport;
    if (parsed && Array.isArray(parsed.steps)) {
      report = parsed;
    }
  } catch {
    // Artifact may not exist yet
  }

  const recordPhase = phaseId;
  const existingIdx = report.steps.findIndex(
    (s) => s.stepIndex === stepIndex && (s.phase ?? 'implement') === recordPhase,
  );
  const newRecord: ScratchFileStepRecord = {
    stepIndex,
    totalSteps,
    stepTitle,
    files,
    ...(phaseId !== 'implement' ? { phase: phaseId } : {}),
  };
  if (existingIdx >= 0) {
    report.steps[existingIdx] = newRecord;
  } else {
    report.steps.push(newRecord);
  }

  try {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId,
      relativePath: SCRATCH_FILES_ARTIFACT_PATH,
      contents: JSON.stringify(report, null, 2),
    });
  } catch {
    // Writing report is best-effort
  }
}

export interface RemediateScratchFilesOpts {
  cwd: string;
  ctx: PhaseHandlerContext;
  statusOutput: string;
  writableSet: ReadonlySet<string>;
  referenceSet: ReadonlySet<string>;
  exemptSet: ReadonlySet<string>;
  stepIndex: number;
  totalSteps: number;
  stepTitle: string;
  phaseId?: string;
  onScratchFilesFound?: (
    allScratchFiles: string[],
    rootFiles: string[],
    subDirFiles: string[],
  ) => void;
}

export interface RemediateScratchFilesResult {
  allScratchFiles: string[];
  rootFilesDeleted: string[];
  subDirFilesRemaining: string[];
}

export async function remediateScratchFiles(
  opts: RemediateScratchFilesOpts,
): Promise<RemediateScratchFilesResult> {
  const allScratchFiles = undeclaredUntrackedFiles(
    opts.statusOutput,
    opts.writableSet,
    opts.referenceSet,
    opts.exemptSet,
  );

  if (allScratchFiles.length === 0) {
    return { allScratchFiles: [], rootFilesDeleted: [], subDirFilesRemaining: [] };
  }

  const rootFiles = allScratchFiles.filter((f) => !f.includes('/'));
  const subDirFiles = allScratchFiles.filter((f) => f.includes('/'));

  if (opts.onScratchFilesFound) {
    opts.onScratchFilesFound(allScratchFiles, rootFiles, subDirFiles);
  }

  const rootFilesDeleted: string[] = [];
  for (const file of rootFiles) {
    try {
      const targetPath = path.resolve(opts.cwd, file);
      if (
        targetPath.startsWith(opts.cwd) &&
        !file.includes('/') &&
        !isProtectedFilePath(file) &&
        !isOrchestratorArtifactPattern(file) &&
        existsSync(targetPath)
      ) {
        unlinkSync(targetPath);
        rootFilesDeleted.push(file);
      }
    } catch {
      // File deletion is best-effort
    }
  }

  await recordScratchFilesReport(
    opts.ctx,
    opts.stepIndex,
    opts.totalSteps,
    opts.stepTitle,
    allScratchFiles,
    opts.phaseId ?? 'implement',
  );

  return {
    allScratchFiles,
    rootFilesDeleted,
    subDirFilesRemaining: subDirFiles,
  };
}

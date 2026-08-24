import type { EventEmitter, PhaseHandlerContext } from './phases/handler.js';
import type { DeleteWorktreeFilePort } from './ports/delete-worktree-file-port.js';
import { normalizeTaskPath } from './task-file-boundaries.js';
import {
  unquoteGitPath,
  isOrchestratorArtifactPattern,
} from './artifacts/orchestrator-artifacts.js';

export const SCRATCH_FILES_ARTIFACT_PATH = '.ai-tmp/scratch-files.json';

export function isProtectedFilePath(filePath: string): boolean {
  const norm = normalizeTaskPath(filePath);
  return (
    norm === '.gitignore' ||
    norm.endsWith('/.gitignore') ||
    norm === '.ai-orchestrator.json' ||
    norm === '.github' ||
    norm.startsWith('.github/')
  );
}

function isExemptOrDeclaredPath(
  path: string,
  writableFiles: ReadonlySet<string>,
  referenceFiles: ReadonlySet<string>,
  exemptFiles: ReadonlySet<string>,
): boolean {
  if (writableFiles.has(path) || referenceFiles.has(path) || exemptFiles.has(path)) {
    return true;
  }
  const prefix = `${path}/`;
  for (const set of [writableFiles, referenceFiles, exemptFiles]) {
    for (const item of set) {
      const itemPrefix = item.endsWith('/') ? item : `${item}/`;
      if (item.startsWith(prefix) || path.startsWith(itemPrefix)) {
        return true;
      }
    }
  }
  return false;
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
    .map((line) => normalizeTaskPath(unquoteGitPath(line.replace(/\r$/, '').slice(3))))
    .filter((p) => p.length > 0)
    .filter(
      (p) =>
        !isExemptOrDeclaredPath(p, writableFiles, referenceFiles, exemptFiles) &&
        !isProtectedFilePath(p) &&
        !isOrchestratorArtifactPattern(p),
    );

  return [...new Set(paths)].sort();
}

export interface ScratchFileStepRecord {
  phaseId?: string | undefined;
  stepIndex: number;
  totalSteps: number;
  stepTitle: string;
  files: string[];
}

export interface ScratchFilesReport {
  steps: ScratchFileStepRecord[];
}

export async function recordScratchFilesReport(
  artifacts: Pick<PhaseHandlerContext['artifacts'], 'read' | 'write'>,
  runUuid: string,
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
      existing = await artifacts.read(runUuid, SCRATCH_FILES_ARTIFACT_PATH);
    } catch {
      existing = await artifacts.read(runUuid, 'scratch-files.json');
    }
    const parsed = JSON.parse(existing) as ScratchFilesReport;
    if (parsed && Array.isArray(parsed.steps)) {
      report = parsed;
    }
  } catch {
    // Artifact may not exist yet
  }

  const existingIdx = report.steps.findIndex(
    (s) =>
      (s.phaseId ?? 'implement') === phaseId &&
      (stepIndex !== 0 && s.stepIndex !== 0
        ? s.stepIndex === stepIndex
        : s.stepTitle === stepTitle),
  );
  const newRecord: ScratchFileStepRecord = { phaseId, stepIndex, totalSteps, stepTitle, files };
  if (existingIdx >= 0) {
    report.steps[existingIdx] = newRecord;
  } else if (files.length > 0) {
    report.steps.push(newRecord);
  } else {
    return;
  }

  try {
    await artifacts.write({
      runId: runUuid,
      phaseId,
      relativePath: SCRATCH_FILES_ARTIFACT_PATH,
      contents: JSON.stringify(report, null, 2),
    });
  } catch {
    // Writing report is best-effort
  }
}

export interface RemediateScratchFilesOptions {
  cwd: string;
  runUuid: string;
  status: string;
  writableFiles: ReadonlySet<string>;
  referenceFiles: ReadonlySet<string>;
  exemptFiles: ReadonlySet<string>;
  artifacts: Pick<PhaseHandlerContext['artifacts'], 'read' | 'write'>;
  deleteWorktreeFile?: DeleteWorktreeFilePort | undefined;
  emit?: EventEmitter | undefined;
  phase?: string | undefined;
  stepIndex?: number | undefined;
  totalSteps?: number | undefined;
  stepTitle?: string | undefined;
}

export interface RemediateScratchFilesResult {
  allScratchFiles: string[];
  deletedFiles: string[];
  remainingFiles: string[];
  remediated: boolean;
}

export async function remediateScratchFiles(
  opts: RemediateScratchFilesOptions,
): Promise<RemediateScratchFilesResult> {
  const allScratchFiles = undeclaredUntrackedFiles(
    opts.status,
    opts.writableFiles,
    opts.referenceFiles,
    opts.exemptFiles,
  );

  if (allScratchFiles.length === 0) {
    await recordScratchFilesReport(
      opts.artifacts,
      opts.runUuid,
      opts.stepIndex ?? 0,
      opts.totalSteps ?? 1,
      opts.stepTitle ?? opts.phase ?? 'unknown',
      [],
      opts.phase ?? 'implement',
    );
    return {
      allScratchFiles: [],
      deletedFiles: [],
      remainingFiles: [],
      remediated: false,
    };
  }

  if (opts.emit) {
    if (opts.phase === 'implement' && opts.stepIndex !== undefined) {
      opts.emit(
        'step.scratch_files_left',
        'warn',
        `step ${opts.stepIndex}/${opts.totalSteps ?? 1} left undeclared files: ${allScratchFiles.join(', ')}`,
        {
          index: opts.stepIndex,
          total: opts.totalSteps ?? 1,
          taskTitle: opts.stepTitle ?? `step ${opts.stepIndex}`,
          files: allScratchFiles,
        },
      );
    } else {
      const phaseName = opts.phase ?? 'phase';
      opts.emit(
        `${phaseName}.scratch_files_left`,
        'warn',
        `${phaseName} phase left undeclared files: ${allScratchFiles.join(', ')}`,
        {
          phase: phaseName,
          files: allScratchFiles,
        },
      );
    }
  }

  const deletedFiles: string[] = [];
  if (opts.deleteWorktreeFile) {
    for (const file of allScratchFiles) {
      try {
        if (!isProtectedFilePath(file)) {
          const deleted = await opts.deleteWorktreeFile(opts.cwd, file);
          if (deleted) {
            deletedFiles.push(file);
          }
        }
      } catch {
        // File deletion is best-effort
      }
    }
  }

  await recordScratchFilesReport(
    opts.artifacts,
    opts.runUuid,
    opts.stepIndex ?? 0,
    opts.totalSteps ?? 1,
    opts.stepTitle ?? opts.phase ?? 'unknown',
    allScratchFiles,
    opts.phase ?? 'implement',
  );

  const deletedSet = new Set(deletedFiles);
  const remainingFiles = allScratchFiles.filter((f) => !deletedSet.has(f));

  return {
    allScratchFiles,
    deletedFiles,
    remainingFiles,
    remediated: deletedFiles.length > 0,
  };
}

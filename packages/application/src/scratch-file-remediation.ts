import type { EventEmitter, PhaseHandlerContext } from './phases/handler.js';
import { normalizeTaskPath } from './task-file-boundaries.js';
import {
  unquoteGitPath,
  isOrchestratorArtifactPattern,
} from './artifacts/orchestrator-artifacts.js';

export const SCRATCH_FILES_ARTIFACT_PATH = '.ai-tmp/scratch-files.json';

export function isProtectedFilePath(filePath: string): boolean {
  const norm = normalizeTaskPath(filePath);
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
    .filter((p) => p.length > 0)
    .filter(
      (p) =>
        !writableFiles.has(p) &&
        !referenceFiles.has(p) &&
        !exemptFiles.has(p) &&
        !isProtectedFilePath(p) &&
        !isOrchestratorArtifactPattern(p),
    );

  return [...new Set(paths)].sort();
}

export interface ScratchFileStepRecord {
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
    (s) => s.stepTitle === stepTitle || (stepIndex !== 0 && s.stepIndex === stepIndex),
  );
  const newRecord: ScratchFileStepRecord = { stepIndex, totalSteps, stepTitle, files };
  if (existingIdx >= 0) {
    report.steps[existingIdx] = newRecord;
  } else {
    report.steps.push(newRecord);
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
  emit?: EventEmitter;
  phase?: string;
  stepIndex?: number;
  totalSteps?: number;
  stepTitle?: string;
}

export interface RemediateScratchFilesResult {
  allScratchFiles: string[];
  deletedRootFiles: string[];
  remainingSubDirFiles: string[];
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
    return {
      allScratchFiles: [],
      deletedRootFiles: [],
      remainingSubDirFiles: [],
      remediated: false,
    };
  }

  const rootFiles = allScratchFiles.filter((f) => !f.includes('/'));
  const subDirFiles = allScratchFiles.filter((f) => f.includes('/'));

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
          ...(rootFiles.length > 0 ? { rootFiles } : {}),
          ...(subDirFiles.length > 0 ? { subDirFiles } : {}),
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
          ...(rootFiles.length > 0 ? { rootFiles } : {}),
          ...(subDirFiles.length > 0 ? { subDirFiles } : {}),
        },
      );
    }
  }

  const deletedRootFiles: string[] = [];
  try {
    const fsModName = 'node' + ':fs';
    const fs = (await import(/* @vite-ignore */ fsModName)) as {
      existsSync: (p: string) => boolean;
      unlinkSync: (p: string) => void;
    };
    for (const file of rootFiles) {
      try {
        const targetPath = `${opts.cwd.replace(/\/+$/, '')}/${file}`;
        if (
          targetPath.startsWith(opts.cwd) &&
          !file.includes('/') &&
          !isProtectedFilePath(file) &&
          fs.existsSync(targetPath)
        ) {
          fs.unlinkSync(targetPath);
          deletedRootFiles.push(file);
        }
      } catch {
        // File deletion is best-effort
      }
    }
  } catch {
    // File deletion is best-effort
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

  return {
    allScratchFiles,
    deletedRootFiles,
    remainingSubDirFiles: subDirFiles,
    remediated: deletedRootFiles.length > 0,
  };
}

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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * True when `oldArr` appears as a subsequence of `newArr` — i.e. every entry
 * of `oldArr` is still present in `newArr`, in the same relative order, with
 * nothing removed or reordered. `newArr` may additionally insert new entries
 * anywhere. Used to permit an agent to *add* a validation command without
 * permitting it to remove or reorder an existing one (which would weaken
 * validation rather than strengthen it).
 */
function isPureInsertion(oldArr: readonly string[], newArr: readonly string[]): boolean {
  if (newArr.length <= oldArr.length) return false;
  let i = 0;
  for (const item of newArr) {
    if (i < oldArr.length && item === oldArr[i]) i++;
  }
  return i === oldArr.length;
}

/**
 * `.ai-orchestrator.json` is protected because an agent could otherwise
 * silently weaken its own validation gate (delete a required command, widen
 * a forbidden-artifact allowlist, etc.) and have that change ride along
 * unreviewed in its own PR. But an agent legitimately needs to *add* a new
 * validation command when its own issue scope adds a new test suite that
 * should be enforced going forward (e.g. a new adapter's integration tests) —
 * refusing that penalizes the correct behavior of wiring new tests into the
 * gate. This narrowly permits ONLY that shape of change: `validation.commands`
 * and/or `validation.additionalCommands` gaining new string entries with
 * every existing entry still present in the same order, and nothing else in
 * the file differing at all.
 */
export function isAdditiveOrchestratorConfigChange(
  oldContent: string,
  newContent: string,
): boolean {
  let oldJson: unknown;
  let newJson: unknown;
  try {
    oldJson = JSON.parse(oldContent);
    newJson = JSON.parse(newContent);
  } catch {
    return false;
  }
  if (!isRecord(oldJson) || !isRecord(newJson)) return false;

  const oldValidation = isRecord(oldJson.validation) ? oldJson.validation : undefined;
  const newValidation = isRecord(newJson.validation) ? newJson.validation : undefined;
  if (!oldValidation || !newValidation) return false;

  let sawInsertion = false;
  for (const key of ['commands', 'additionalCommands'] as const) {
    const oldArr = oldValidation[key];
    const newArr = newValidation[key];
    if (deepEqual(oldArr, newArr)) continue;
    if (!isStringArray(oldArr) || !isStringArray(newArr)) return false;
    if (!isPureInsertion(oldArr, newArr)) return false;
    sawInsertion = true;
  }
  if (!sawInsertion) return false;

  const stripCommandArrays = (validation: Record<string, unknown>): Record<string, unknown> => {
    const { commands: _commands, additionalCommands: _additionalCommands, ...rest } = validation;
    return rest;
  };

  const oldRest = { ...oldJson, validation: stripCommandArrays(oldValidation) };
  const newRest = { ...newJson, validation: stripCommandArrays(newValidation) };
  return deepEqual(oldRest, newRest);
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
    .map((line) => normalizeTaskPath(unquoteGitPath(line.slice(3))))
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

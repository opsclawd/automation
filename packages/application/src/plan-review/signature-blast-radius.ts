import type {
  DeclaredSignatureChange,
  SignatureReferenceAnalysis,
  SignatureReferenceLocation,
} from '../ports/signature-reference-analyzer-port.js';
import type { TaskManifest, TaskManifestEntryV2 } from '../results/schemas/task-manifest.js';

export interface DeclaredTaskSignatureChange extends DeclaredSignatureChange {
  n: number;
}

export interface SignatureBlastRadiusFailure {
  taskN: number;
  symbol: string;
  declarationFile: string;
  unresolvedDiagnostic?: string;
  uncoveredReferences: SignatureReferenceLocation[];
}

export interface SignatureBlastRadiusCheckResult {
  pass: boolean;
  failures: SignatureBlastRadiusFailure[];
}

function normalizeFile(file: string): string {
  return file.replace(/\\/g, '/');
}

function getOwnedFiles(task: TaskManifestEntryV2): Set<string> {
  const files = task.expected_files ?? task.files ?? [];
  return new Set(files.map(normalizeFile));
}

function collectSignatureChangesFromTask(task: TaskManifestEntryV2): DeclaredTaskSignatureChange[] {
  if (!task.signature_changes) {
    return [];
  }
  return task.signature_changes.map((sc) => ({
    n: task.n,
    declarationFile: normalizeFile(sc.declaration_file),
    symbol: sc.symbol,
  }));
}

export function collectDeclaredSignatureChanges(
  manifest: TaskManifest,
): DeclaredTaskSignatureChange[] {
  if (manifest.version === 1) {
    return [];
  }

  const changes: DeclaredTaskSignatureChange[] = [];
  for (const task of manifest.tasks) {
    if (task.signature_changes && task.signature_changes.length > 0) {
      changes.push(...collectSignatureChangesFromTask(task as TaskManifestEntryV2));
    }
  }
  return changes;
}

function isFileOwnedByChangingOrLaterTask(
  file: string,
  changingTaskN: number,
  manifest: TaskManifest,
): boolean {
  const normalizedFile = normalizeFile(file);

  for (const task of manifest.tasks) {
    if (task.n < changingTaskN || task.n > manifest.task_count) {
      continue;
    }

    let ownedFiles: Set<string>;
    if (manifest.version === 1) {
      ownedFiles = new Set((task.files ?? []).map(normalizeFile));
    } else {
      const v2Task = task as TaskManifestEntryV2;
      ownedFiles = getOwnedFiles(v2Task);
    }

    if (ownedFiles.has(normalizedFile)) {
      return true;
    }
  }

  return false;
}

export function evaluateSignatureBlastRadius(
  manifest: TaskManifest,
  analyses: SignatureReferenceAnalysis[],
): SignatureBlastRadiusCheckResult {
  if (analyses.length === 0) {
    return { pass: true, failures: [] };
  }

  const changes = collectDeclaredSignatureChanges(manifest);
  if (changes.length === 0) {
    return { pass: true, failures: [] };
  }

  type FailureEntry = {
    taskN: number;
    symbol: string;
    declarationFile: string;
    unresolvedDiagnostic?: string;
    uncoveredReferences: SignatureReferenceLocation[];
  };

  const grouped = new Map<string, FailureEntry>();

  for (const analysis of analyses) {
    const change = analysis.change;
    const changeInfo = changes.find(
      (c) => c.declarationFile === change.declarationFile && c.symbol === change.symbol,
    );

    if (changeInfo === undefined) {
      continue;
    }

    const key = `${changeInfo.n}|${change.declarationFile}|${change.symbol}`;

    let entry = grouped.get(key);
    if (entry === undefined) {
      entry = {
        taskN: changeInfo.n,
        symbol: change.symbol,
        declarationFile: change.declarationFile,
        uncoveredReferences: [],
      };
      grouped.set(key, entry);
    }

    if (analysis.unresolvedDiagnostic) {
      entry.unresolvedDiagnostic = analysis.unresolvedDiagnostic;
    } else {
      for (const ref of analysis.references) {
        if (!isFileOwnedByChangingOrLaterTask(ref.file, changeInfo.n, manifest)) {
          entry.uncoveredReferences.push(ref);
        }
      }
    }
  }

  const failures: SignatureBlastRadiusFailure[] = [];

  for (const entry of grouped.values()) {
    const seen = new Set<string>();
    const deduplicated: SignatureReferenceLocation[] = [];

    for (const ref of entry.uncoveredReferences) {
      const refKey = `${ref.file}|${ref.line}|${ref.column}`;
      if (!seen.has(refKey)) {
        seen.add(refKey);
        deduplicated.push(ref);
      }
    }

    if (deduplicated.length > 0 || entry.unresolvedDiagnostic !== undefined) {
      const failure: SignatureBlastRadiusFailure = {
        taskN: entry.taskN,
        symbol: entry.symbol,
        declarationFile: entry.declarationFile,
        uncoveredReferences: deduplicated,
      };
      if (entry.unresolvedDiagnostic !== undefined) {
        failure.unresolvedDiagnostic = entry.unresolvedDiagnostic;
      }
      failures.push(failure);
    }
  }

  const sortedFailures = sortFailures(failures);
  return { pass: failures.length === 0, failures: sortedFailures };
}

function sortFailures(failures: SignatureBlastRadiusFailure[]): SignatureBlastRadiusFailure[] {
  return [...failures].sort((a, b) => {
    if (a.taskN !== b.taskN) {
      return a.taskN - b.taskN;
    }
    if (a.declarationFile !== b.declarationFile) {
      return a.declarationFile.localeCompare(b.declarationFile);
    }
    if (a.symbol !== b.symbol) {
      return a.symbol.localeCompare(b.symbol);
    }
    return 0;
  });
}

export function renderSignatureBlastRadiusDiagnostic(
  failures: SignatureBlastRadiusFailure[],
): string | null {
  if (failures.length === 0) {
    return null;
  }

  const lines: string[] = [];

  for (const failure of failures) {
    lines.push(
      `Task ${failure.taskN} changes ${failure.symbol}, but these reference files are not declared by Task ${failure.taskN} or a later task:`,
    );

    if (failure.unresolvedDiagnostic) {
      lines.push(`  (unresolved: ${failure.unresolvedDiagnostic})`);
    }

    const sortedRefs = [...failure.uncoveredReferences].sort((a, b) => {
      if (a.file !== b.file) {
        return a.file.localeCompare(b.file);
      }
      if (a.line !== b.line) return a.line - b.line;
      return a.column - b.column;
    });

    for (const ref of sortedRefs) {
      lines.push(`  - ${ref.file}:${ref.line}:${ref.column}`);
    }

    lines.push('');
  }

  return lines.join('\n').trim();
}

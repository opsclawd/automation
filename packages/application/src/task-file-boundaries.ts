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
    .filter((file) => !writableFiles.has(file) && !exemptFiles.has(file))
    .sort();
  return {
    modifiedReferenceFiles: undeclared.filter((file) => referenceFiles.has(file)),
    undeclaredFiles: undeclared.filter((file) => !referenceFiles.has(file)),
  };
}

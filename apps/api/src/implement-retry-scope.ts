export interface ImplementRetryScopeMetadata {
  additional_editable_files?: string[];
}

export function canonicalizeAdditionalEditableFiles(files: string[] | undefined): string[] {
  if (files === undefined || files.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const file of files) {
    if (!seen.has(file)) {
      seen.add(file);
      result.push(file);
    }
  }
  result.sort();
  return result;
}

export function renderImplementRetryScopePrompt(files: string[] | undefined): string[] {
  const canonical = canonicalizeAdditionalEditableFiles(files);
  if (canonical.length === 0) {
    return [];
  }
  return [
    '## TYPECHECK-AUTHORIZED SCOPE OVERRIDE',
    '',
    'The whole-repository typecheck directly implicated these existing files:',
    ...canonical.map((f) => `- ${f}`),
    '',
    'You may edit only these additional existing files, and only to resolve the',
    'listed compile failures. This narrow authorization overrides the later-task',
    'file prohibition for this retry; it does not authorize later-task behavior,',
    'new files, dependencies, migrations, or unrelated refactors.',
  ];
}

export function buildImplementRetryScopeMetadata(
  files: string[] | undefined,
): ImplementRetryScopeMetadata {
  const canonical = canonicalizeAdditionalEditableFiles(files);
  if (canonical.length === 0) {
    return {};
  }
  return {
    additional_editable_files: canonical,
  };
}

export function renderMissingDeclaredFilesPrompt(files: string[] | undefined): string[] {
  if (files === undefined || files.length === 0) {
    return [];
  }
  const canonical = [...files].sort();
  return [
    '## MISSING DECLARED FILES — MUST CREATE',
    '',
    'The following files were declared in expected_files but were NOT committed',
    'on the previous attempt. You MUST create and commit these files:',
    ...canonical.map((f) => `- ${f}`),
    '',
    'These are brand new files that do not exist yet. Create them with appropriate',
    'content before the typecheck and review gates run.',
  ];
}

export function renderDeclaredFilesRetryPrompt(priorAttemptMissingFiles?: string[]): string[] {
  if (!priorAttemptMissingFiles?.length) return [];
  return [
    '## DECLARED FILES MISSED BY THE PREVIOUS ATTEMPT',
    '',
    'The previous attempt declared these files in expected_files but did not commit them.',
    'You MUST modify and commit every file listed below during this attempt:',
    '',
    ...priorAttemptMissingFiles.map((file) => `- ${file}`),
    '',
    'Do not remove the declarations merely to satisfy commit coverage. Implement the task',
    'behavior in these files, then run the task-scoped validation and commit the result.',
    '',
  ];
}

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

export function renderDeclaredFilesRetryPrompt(
  priorAttemptMissingFiles?: string[],
  priorAttemptUndeclaredFiles?: string[],
  priorAttemptModifiedReferenceFiles?: string[],
): string[] {
  const sections: string[] = [];

  if (priorAttemptMissingFiles?.length) {
    sections.push(
      '## DECLARED FILES MISSED BY THE PREVIOUS ATTEMPT',
      '',
      'If the previous attempt changed these files, that uncommitted work is still in your working tree.',
      'Inspect git status to check existing uncommitted work and modify and commit every file listed below:',
      '',
      ...priorAttemptMissingFiles.map((file) => `- ${file}`),
      '',
      '- If a listed file already contains correct changes: review and stage it; do not reimplement it.',
      '- If a listed file is absent or incomplete: implement the required behavior.',
      'Then run task-scoped validation, validate and commit every listed file.',
      '',
    );
  }

  const canonicalModifiedReference = canonicalizeAdditionalEditableFiles(
    priorAttemptModifiedReferenceFiles,
  );
  if (canonicalModifiedReference.length > 0) {
    sections.push(
      '## MODIFIED READ-ONLY REFERENCE FILES — REMOVE FROM THIS TASK COMMIT',
      '',
      'The previous attempt modified files that are declared as read-only reference_files for this task:',
      ...canonicalModifiedReference.map((f) => `- ${f}`),
      '',
      'Reference files provide read-only context for the current task and must not be modified in this task commit.',
      'The manifest cannot be broadened, later-task work is not authorized, and you must not add these files to expected_files.',
      "You must rewrite only the current task's commit(s) to remove modifications to these reference files.",
      '',
      'Safe recovery procedure:',
      '- For a single-commit attempt: run `git reset HEAD~1 --soft`, then run `git restore --source=HEAD --staged --worktree -- <path>` for each invalid path listed above.',
      '- If the current Step produced multiple commits, inspect `git log` and use the original current-Step baseline to rewrite only current task commits.',
      '- Restage and commit only current expected_files. Never delete arbitrary repository state or change earlier successful Step commits.',
      '',
    );
  }

  const canonicalUndeclared = canonicalizeAdditionalEditableFiles(priorAttemptUndeclaredFiles);
  if (canonicalUndeclared.length > 0) {
    sections.push(
      '## COMMITTED FILES OUTSIDE THIS TASK — REMOVE FROM THIS TASK COMMIT',
      '',
      "The previous attempt committed files that are outside this task's declared expected_files:",
      ...canonicalUndeclared.map((f) => `- ${f}`),
      '',
      'These files belong to other tasks or are undeclared. You must not create or modify them in this task commit.',
      'The manifest cannot be broadened, later-task work is not authorized, and you must not add these files to expected_files.',
      "You must rewrite only the current task's commit(s) to remove modifications to these undeclared files.",
      '',
      'Safe recovery procedure:',
      '- For a single-commit attempt: run `git reset HEAD~1 --soft`, then run `git restore --source=HEAD --staged --worktree -- <path>` for each invalid path listed above.',
      '- If the current Step produced multiple commits, inspect `git log` and use the original current-Step baseline to rewrite only current task commits.',
      '- Restage and commit only current expected_files. Never delete arbitrary repository state or change earlier successful Step commits.',
      '',
    );
  }

  return sections;
}

import {
  type ArchitectPlan,
  WORKSPACE_CONSTRAINTS,
  SCRATCH_FILE_POLICY,
  getGitCommitExcludePathspecsString,
} from '@ai-sdlc/application';

export interface BuildFixPromptInput {
  cwd: string;
  repoId: string;
  allowedFiles?: string[];
  historyContext?: string;
  architectPlan?: ArchitectPlan;
  useFallback?: boolean;
  extraPromptSections?: string[];
  deterministicDiagnostic?: string;
  reconciliationContext?: string;
}

export function buildReviewFixFixPrompt(input: BuildFixPromptInput): string {
  const sections: string[] = [
    'You are fixing code review findings on the current branch.',
    '',
    '## CONTEXT',
    '',
    WORKSPACE_CONSTRAINTS,
    '',
    SCRATCH_FILE_POLICY,
    '',
    `Working directory: ${input.cwd}`,
    `Repository: ${input.repoId}`,
    '',
  ];

  if (input.allowedFiles && input.allowedFiles.length > 0) {
    sections.push(
      '## ALLOWED EDIT SCOPE',
      'This fix is expected to edit only the following files:',
      ...input.allowedFiles.map((f) => `- ${f}`),
      '',
      'Adjacent edits outside this set are allowed when justified. However, for every edited path outside this set, you MUST provide an entry in `out_of_scope_reasons` mapping the path to a brief justification.',
      '',
    );
  }

  if (input.historyContext) {
    sections.push(input.historyContext);
  }

  if (input.deterministicDiagnostic) {
    sections.push(
      '## DETERMINISTIC DIAGNOSTIC',
      'A deterministic failure or manifest mismatch was detected:',
      '```',
      input.deterministicDiagnostic.slice(0, 8192),
      '```',
      '',
      'You MUST resolve this deterministic failure before performing other work.',
      '',
    );
  }

  if (input.reconciliationContext) {
    sections.push(
      '## RECONCILIATION CONTEXT',
      'The orchestrator escalated a review/fix contradiction to an arbiter, which ruled:',
      '```',
      input.reconciliationContext,
      '```',
      '',
    );
  }

  sections.push(
    '## TASK',
    'Read the code review findings.',
    'Fix ALL legitimate review findings across all severities.',
    '',
    'Rules:',
    '- Fix only what the review asks for. Do not expand scope.',
    '- Do not rewrite working code for style preference.',
    '- If a finding is invalid, skip it.',
    '',
    'After fixing, write a result.json file with exactly one of:',
    '{ "result": "done_with_fixes", "out_of_scope_reasons": {} }',
    '{ "result": "done_no_fixes_needed", "rebuttal": "explain why no fixes are needed", "out_of_scope_reasons": {} }',
    '{ "result": "cannot_fix" }',
  );

  if (input.architectPlan) {
    sections.push(
      '',
      '## CROSS-TASK FIX PLAN',
      'The following architect analysis provides cross-task context for this fix:',
      ...input.architectPlan.tasks.map((t) =>
        [
          `### Task: ${t.task_id}`,
          `**Approach:** ${t.approach}`,
          ...(t.conflicts_resolved.length > 0
            ? [`**Conflicts resolved:** ${t.conflicts_resolved.join(', ')}`]
            : []),
          ...(t.constraints.length > 0 ? [`**Constraints:** ${t.constraints.join(', ')}`] : []),
          ...(t.depends_on.length > 0 ? [`**Depends on:** ${t.depends_on.join(', ')}`] : []),
        ].join('\n'),
      ),
    );
  }

  const excludes = getGitCommitExcludePathspecsString();
  sections.push(
    '',
    '## CRITICAL RULES',
    '- Do NOT ask questions.',
    '- Do NOT switch branches. All work must stay on the current branch.',
    '- After fixing, commit your change before writing result.json:',
    '  1. Record HEAD before: `PRE_HEAD=$(git rev-parse HEAD)`',
    `  2. Stage and commit: \`git add -A -- . ${excludes} && git commit -m "fix: review findings"\``,
    '  3. If git commit exits non-zero, the pre-commit hook failed. Read the hook/lint',
    '     output, FIX the reported errors, and retry the commit. Never report',
    '     result="done_with_fixes" with a failed or skipped commit.',
    '  4. After a successful commit, confirm HEAD advanced:',
    '     `[ "$(git rev-parse HEAD)" != "$PRE_HEAD" ] || { echo "COMMIT DID NOT ADVANCE HEAD"; exit 1; }`',
    `  5. Confirm clean worktree:\n     \`[ -z "$(git status --porcelain -- . ${excludes})" ] || { echo "WORKTREE DIRTY AFTER COMMIT"; exit 1; }\``,
    '  6. Only write "done_with_fixes" in result.json after steps 4 and 5 both pass.',
    '- Write result.json last.',
  );

  if (input.useFallback) {
    sections.push(
      '',
      '## NOTE',
      'The previous fix attempt failed. Review the current state carefully',
      'and consider a different approach to address the findings.',
    );
  }

  if (input.extraPromptSections && input.extraPromptSections.length > 0) {
    sections.push(...input.extraPromptSections);
  }

  return sections.join('\n');
}

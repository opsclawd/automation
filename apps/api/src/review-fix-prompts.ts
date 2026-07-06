import { type ArchitectPlan } from '@ai-sdlc/application';

export interface BuildReviewPromptInput {
  cwd: string;
  repoId: string;
  defaultBranch: string;
  gateFailureOutput?: string | undefined;
  historyContext?: string | undefined;
  /**
   * When provided AND iterationIndex >= 2, the reviewer's `git diff`
   * command is constrained to `git diff <prevReviewedCommitSha>..HEAD`
   * so the review surface shrinks monotonically instead of re-litigating
   * settled code (#627).
   */
  prevReviewedCommitSha?: string | undefined;
}

export interface BuildFixPromptInput {
  cwd: string;
  repoId: string;
  historyContext?: string | undefined;
  architectPlan?: ArchitectPlan | undefined;
  useFallback: boolean;
  extraPromptSections?: string[] | undefined;
}

export function buildReviewFixReviewPrompt(input: BuildReviewPromptInput): string {
  const sections: string[] = [
    'You are reviewing code changes in a pull request.',
    '',
    '## CONTEXT',
    `Working directory: ${input.cwd}`,
    `Repository: ${input.repoId}`,
    '',
    '## TASK',
    input.prevReviewedCommitSha
      ? `Run: git diff ${input.prevReviewedCommitSha}..HEAD`
      : `Run: git diff origin/${input.defaultBranch}...HEAD`,
    'Read the diff carefully.',
    '',
    'Write a code review to ./code-review.md.',
    '',
    'For each finding you MUST include:',
    '- severity: critical | high | medium | low',
    '- file path and line reference (if applicable)',
    '- evidence: what you observed in the diff',
    '- failure mode: why this is a problem',
    '- required fix: specific action to resolve the issue',
    '',
    'Categorize findings:',
    '- critical: security, data loss, production-breaking',
    '- high: correct behavior violation, significant bugs',
    '- medium: suboptimal patterns, missing tests',
    '- low: style, formatting, minor improvements',
    '',
    'After writing the review, write a result.json file with:',
    '{ "result": "pass" | "fail", "findings": [{ "severity": "...", "summary": "..." }] }',
    'Use "pass" when there are no significant findings, "fail" when changes are needed.',
    '',
  ];

  if (input.gateFailureOutput) {
    sections.push(
      '## BUILD/LINT FAILURE',
      'The orchestrator detected mechanical errors in the fixer commit before this review.',
      'Result: FAIL',
      '',
      'Errors:',
      '```',
      input.gateFailureOutput,
      '```',
      '',
      'Surface these errors as HIGH severity findings and do NOT pass this review.',
      '',
    );
  }

  if (input.historyContext) {
    sections.push(input.historyContext);
  }

  if (input.prevReviewedCommitSha) {
    sections.push(
      '',
      '## SCOPE',
      'You are reviewing code changes within an automated review/fix loop.',
      'Code outside the diff below is OUT OF SCOPE unless a new finding',
      'requires referencing prior context. Do NOT re-flag findings that',
      'a prior iteration already addressed — see "Disposition of',
      'Previously Open Findings" below.',
      '',
      '## DISPOSITION GUIDANCE',
      'For each prior finding, the history section will mark it as either',
      '"Disposition: addressed by fix" or "Disposition: rebutted by fixer".',
      '- Addressed findings: confirm the fix actually resolved the issue',
      '  against the current diff. Do NOT re-flag the same finding unless',
      '  the fix is incomplete.',
      '- Rebutted findings: the fixer asserted no change was needed. Confirm',
      '  this against the current code. Re-flag ONLY if you find new',
      '  evidence in the current diff that supports the original concern.',
      '',
    );
  }

  sections.push(
    '## CRITICAL RULES',
    '- Do NOT ask questions.',
    '- Do NOT switch branches. All work must stay on the current branch.',
    '- Do NOT write any other files. No scratch files, no `git diff > file`, no temporary files.',
    '- Write code-review.md first, then result.json.',
  );

  return sections.join('\n');
}

export function buildReviewFixFixPrompt(input: BuildFixPromptInput): string {
  const sections: string[] = [
    'You are fixing code review findings.',
    '',
    '## CONTEXT',
    `Working directory: ${input.cwd}`,
    `Repository: ${input.repoId}`,
    'Review findings: ./code-review.md',
    '',
  ];

  if (input.historyContext) {
    sections.push(input.historyContext);
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
    '{ "result": "done_with_fixes" }',
    '{ "result": "done_no_fixes_needed", "rebuttal": "explain why no fixes are needed" }',
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

  sections.push(
    '',
    '## CRITICAL RULES',
    '- Do NOT ask questions.',
    '- Do NOT switch branches. All work must stay on the current branch.',
    '- After fixing, run: git add -A && git commit -m "fix: review findings"',
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

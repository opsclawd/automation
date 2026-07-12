import {
  type ArchitectPlan,
  WORKSPACE_CONSTRAINTS,
  type ReviewMode,
  type ReviewFindingRecord,
  type DispositionHistoryEntry,
} from '@ai-sdlc/application';

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
  mode?: ReviewMode | undefined;
  unresolvedRecords?: ReviewFindingRecord[] | undefined;
  dispositionHistory?: DispositionHistoryEntry[] | undefined;
  deterministicDiagnostics?: string | undefined;
}

export interface BuildFixPromptInput {
  cwd: string;
  repoId: string;
  historyContext?: string | undefined;
  architectPlan?: ArchitectPlan | undefined;
  useFallback: boolean;
  extraPromptSections?: string[] | undefined;
  deterministicDiagnostic?: string | undefined;
  reconciliationContext?: string | undefined;
}

export function buildReviewFixReviewPrompt(input: BuildReviewPromptInput): string {
  const sections: string[] = [
    'You are reviewing code changes in a pull request.',
    '',
    '## CONTEXT',
    '',
    WORKSPACE_CONSTRAINTS,
    '',
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

  const diag = input.gateFailureOutput || input.deterministicDiagnostics;
  if (diag) {
    sections.push(
      '## BUILD/LINT FAILURE',
      'The orchestrator detected mechanical errors in the fixer commit before this review.',
      'Result: FAIL',
      '',
      'Errors:',
      '```',
      diag,
      '```',
      '',
      'Surface these errors as HIGH severity findings and do NOT pass this review.',
      '',
    );
  }

  if (input.mode === 'integration_full' || input.mode === 'intermediate_delta') {
    sections.push(
      '## INTEGRATION MODE',
      `Review Mode: ${input.mode}`,
      '',
      'You are performing a whole-PR integration review. Prioritize integration concerns:',
      '- Cross-task wiring issues',
      '- Composition-root omissions',
      '- Incompatible abstractions',
      '- State-machine paths spanning components',
      '- Migrations and compatibility',
      '- Conflicting task commits',
      '- Issue acceptance criteria',
      '',
      'Do NOT re-raise settled local task findings unless you name new integration evidence and the relevant snapshot/delta.',
      '',
    );
    if (input.unresolvedRecords && input.unresolvedRecords.length > 0) {
      sections.push('### UNRESOLVED INTEGRATION FINDINGS');
      for (const rec of input.unresolvedRecords) {
        sections.push(`- [${rec.severity}] ${rec.summary} (Fingerprint: ${rec.fingerprint})`);
      }
      sections.push('');
    }
    if (input.dispositionHistory && input.dispositionHistory.length > 0) {
      sections.push('### COMPACT FINDING DISPOSITIONS');
      for (const disp of input.dispositionHistory) {
        sections.push(
          `- Fingerprint: ${disp.fingerprint} -> Disposition: ${disp.disposition} (Changed: ${disp.changedAt})`,
        );
      }
      sections.push('');
    }
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
    '',
    WORKSPACE_CONSTRAINTS,
    '',
    `Working directory: ${input.cwd}`,
    `Repository: ${input.repoId}`,
    'Review findings: ./code-review.md',
    '',
  ];

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
    '- After fixing, commit your change before writing result.json:',
    '  1. Record HEAD before: `PRE_HEAD=$(git rev-parse HEAD)`',
    '  2. Stage and commit: `git add -A && git commit -m "fix: review findings"`',
    '  3. If git commit exits non-zero, the pre-commit hook failed. Read the hook/lint',
    '     output, FIX the reported errors, and retry the commit. Never report',
    '     result="done_with_fixes" with a failed or skipped commit.',
    '  4. After a successful commit, confirm HEAD advanced:',
    '     `[ "$(git rev-parse HEAD)" != "$PRE_HEAD" ] || { echo "COMMIT DID NOT ADVANCE HEAD"; exit 1; }`',
    '  5. Confirm clean worktree:',
    '     `[ -z "$(git status --porcelain)" ] || { echo "WORKTREE DIRTY AFTER COMMIT"; exit 1; }`',
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

export interface BuildWholePrArbiterPromptInput {
  cwd: string;
  repoId: string;
  disputedFindings: Array<{
    fingerprint: string;
    severity: string;
    summary: string;
  }>;
  dispositionHistory: Array<{
    fingerprint: string;
    disposition: string;
    changedAt: string;
    reason?: string;
  }>;
  relevantExcerpts: string[];
  fixDelta: string;
  fixRebuttal: string;
  deterministicDiagnostics?: string;
}

export function buildWholePrArbiterPrompt(input: BuildWholePrArbiterPromptInput): string {
  const sections: string[] = [
    'You are arbitrating a contradiction in a whole-PR integration review.',
    '',
    '## CONTEXT',
    '',
    WORKSPACE_CONSTRAINTS,
    '',
    `Working directory: ${input.cwd}`,
    `Repository: ${input.repoId}`,
    '',
    '## DISPUTED INTEGRATION FINDINGS',
  ];

  for (const f of input.disputedFindings) {
    sections.push(`- [${f.severity}] ${f.summary} (Fingerprint: ${f.fingerprint})`);
  }
  sections.push('', '## DISPOSITION HISTORY');

  if (input.dispositionHistory.length > 0) {
    for (const h of input.dispositionHistory) {
      sections.push(`- Disposition: ${h.disposition} (Changed: ${h.changedAt})`);
      if (h.reason) {
        sections.push(`  Reason: ${h.reason}`);
      }
    }
  } else {
    sections.push('No prior disposition history.');
  }

  sections.push(
    '',
    '## FIXER REBUTTAL',
    '```',
    input.fixRebuttal || '(empty rebuttal)',
    '```',
    '',
    '## RELEVANT EXCERPTS',
  );

  if (input.relevantExcerpts.length > 0) {
    for (const exc of input.relevantExcerpts) {
      sections.push('```', exc, '```');
    }
  } else {
    sections.push('No relevant excerpts.');
  }

  sections.push('', '## FIX DELTA', '```diff', input.fixDelta || '(no delta)', '```');

  if (input.deterministicDiagnostics) {
    sections.push('', '## DETERMINISTIC DIAGNOSTICS', '```', input.deterministicDiagnostics, '```');
  }

  sections.push(
    '',
    '## TASK',
    'Determine if the disputed integration findings are valid or invalid based on the evidence.',
    'You must return one of:',
    '- finding_valid: at least one finding is correct and the fixer must address it',
    '- finding_invalid: all findings are incorrect or the fixer is right to rebut them',
    '- ambiguous: the issues are unclear from the evidence',
    '- insufficient_evidence: you lack the evidence to decide',
    '',
    'After arbitrating, write a result.json file with:',
    '{ "outcome": "finding_valid" | "finding_invalid" | "ambiguous" | "insufficient_evidence", "evidence": "your detailed observations", "rationale": "your detailed reasoning" }',
    '',
    '## CRITICAL RULES',
    '- Do NOT ask questions.',
    '- Do NOT switch branches. All work must stay on the current branch.',
    '- Write result.json.',
  );

  return sections.join('\n');
}

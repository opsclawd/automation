import type { TypecheckResult } from '@ai-sdlc/application';
import { WORKSPACE_CONSTRAINTS } from '@ai-sdlc/application';

export interface BuildArbiterPromptContext {
  stepIndex: number;
  stepTitle: string;
  cwd: string;
}

export interface DisputedFinding {
  fingerprint: string;
  severity: string;
  summary: string;
  file?: string;
  suggested_fix?: string;
}

export interface DispositionHistoryEntry {
  fingerprint: string;
  disposition: 'open' | 'addressed' | 'rebutted' | 'settled' | 'recurred';
  reason?: string;
}

export interface BuildArbiterPromptInputs {
  tcResult: TypecheckResult;
  /** The disputed finding that requires arbitration. */
  disputedFinding: DisputedFinding;
  /** Disposition history for the disputed finding. */
  dispositionHistory: DispositionHistoryEntry[];
  /** The fix agent's free-text rebuttal (may be empty). */
  fixRebuttal: string;
  /** Deterministic diagnostics (typecheck errors that are objective evidence). */
  deterministicDiagnostics?: string;
  /** Exact fix delta (git diff between base and HEAD). */
  fixDelta?: string;
  /** The plan.md body of this Task N (e.g. `extractTaskBody` output). */
  taskBody: string;
}

function buildTypecheckSection(tcResult: TypecheckResult): string {
  return tcResult.outcome === 'pass'
    ? '## TYPECHECK RESULT\nThe orchestrator ran `pnpm -r typecheck` after implement completed.\nResult: PASS\n\nThe typecheck is green. Treat typecheck-valid code as objectively correct unless you find explicit evidence of a different defect.'
    : `## TYPECHECK RESULT\nThe orchestrator ran \`pnpm -r typecheck\` after implement completed.\nResult: FAIL\n\nTypecheck errors:\n\`\`\`\n${tcResult.output}\n\`\`\`\n\nNote: a typecheck failure is usually OBJECTIVE EVIDENCE — when present, prefer finding_valid.`;
}

export function buildArbiterPrompt(
  ctx: BuildArbiterPromptContext,
  inputs: BuildArbiterPromptInputs,
): string {
  const typecheckSection = buildTypecheckSection(inputs.tcResult);

  const sections: string[] = [];

  sections.push(
    '# TASK',
    `You are arbitrating a review/fix contradiction for step ${ctx.stepIndex}: ${ctx.stepTitle}.`,
    '',
    'PHASE: READ-ONLY ARBITRATION.',
    'You MUST NOT modify any code, tests, plan, or config. Your sole output is a single `result.json` file describing the ruling.',
    '',
    '## CONTEXT',
    '',
    WORKSPACE_CONSTRAINTS,
    '',
    `Working directory: ${ctx.cwd}`,
    `Step: ${ctx.stepIndex} — ${ctx.stepTitle}`,
    '',
    'The orchestrator ran review + fix iterations and the reviewer reports FAIL while the fixer reports done_no_fixes_needed.',
    'You must rule which side is correct (or that the evidence is inconclusive).',
    '',
    '## INPUTS',
    '',
    typecheckSection,
    '',
    '### Plan task body (the source of truth)',
    '```',
    inputs.taskBody || '(empty)',
    '```',
    '',
    '### DISPUTED FINDING',
    '```json',
    JSON.stringify(inputs.disputedFinding, null, 2),
    '```',
    '',
  );

  if (inputs.dispositionHistory && inputs.dispositionHistory.length > 0) {
    sections.push(
      '### DISPOSITION HISTORY',
      '```json',
      JSON.stringify(inputs.dispositionHistory, null, 2),
      '```',
      '',
    );
  }

  sections.push(
    '### Fixer rebuttal (verbatim)',
    inputs.fixRebuttal || '(no rebuttal provided)',
    '',
  );

  if (inputs.deterministicDiagnostics) {
    sections.push(
      '### DETERMINISTIC DIAGNOSTICS',
      '```',
      inputs.deterministicDiagnostics,
      '```',
      '',
    );
  }

  if (inputs.fixDelta) {
    sections.push('### EXACT FIX DELTA', '```diff', inputs.fixDelta, '```', '');
  } else {
    sections.push('### EXACT FIX DELTA', '(not available — cannot determine fix delta)', '');
  }

  sections.push(
    '## DECISION FRAMEWORK',
    'Pick exactly one of these outcomes:',
    '- **finding_valid** — the reviewer is right; the fix step missed a real defect. Cite the typecheck error, the spec-review finding, or the plan task body that proves it.',
    '- **finding_invalid** — the reviewer is wrong; the fix is correct and no defect exists. Cite the typecheck pass, the plan task body, or external evidence that disproves the finding.',
    '- **ambiguous** — both interpretations are defensible from the available artifacts. Cite what each side claims.',
    '- **insufficient_evidence** — the artifacts are unreadable or absent. Cite what is missing.',
    '',
    'Deterministic signals (use them, do not re-derive):',
    '- Typecheck FAIL with an error in the code the reviewer flagged → strong evidence for finding_valid.',
    '- Typecheck PASS and the reviewer only cites style → finding_invalid.',
    '- Findings that contradict the verbatim plan task body → finding_invalid.',
    '- Findings that match the verbatim plan task body verbatim and the fix ignored them → finding_valid.',
    '',
    '## OUTPUT',
    'Write a single file named `result.json` at the working-directory root with this exact shape (no extra keys, no comments):',
    '```json',
    '{',
    '  "outcome": "finding_valid | finding_invalid | ambiguous | insufficient_evidence",',
    '  "defect_classification": "<P0..P3 | omitted when N/A>",',
    '  "evidence": "<non-empty: the specific artifact or finding that supports your ruling>",',
    '  "rationale": "<non-empty: your reasoning, in one paragraph>"',
    '}',
    '```',
    'Rules:',
    '- `evidence` MUST be non-empty. The orchestrator treats empty evidence as a hard failure and escalates to a human.',
    '- Do NOT re-run typecheck, lint, or tests.',
    '- Do NOT read additional files beyond the inputs above.',
    '- Do NOT write any code, scratch files, or modifications to the repo.',
    'STOP RULE: as soon as `result.json` is written, end your turn.',
  );

  return sections.join('\n');
}

export interface BuildImplementStepFinalReviewArbiterPromptInputs {
  /** Most-recent spec-review result.json excerpt (first ~4 KB). */
  specExcerpt: string;
  /** Most-recent quality-review result.json excerpt (first ~4 KB). */
  qualityExcerpt: string;
  /** The plan.md body of this Task N (e.g. `extractTaskBody` output). */
  taskBody: string;
}

export function buildImplementStepFinalReviewArbiterPrompt(
  ctx: BuildArbiterPromptContext,
  inputs: BuildImplementStepFinalReviewArbiterPromptInputs,
): string {
  const typecheckSection =
    '## TYPECHECK RESULT\nThe orchestrator ran `pnpm -r typecheck` after implement completed.\nResult: PASS\n\nThe typecheck is green. Treat typecheck-valid code as objectively correct unless you find explicit evidence of a different defect.';

  return [
    '# TASK',
    `You are arbitrating a trailing final-review finding for step ${ctx.stepIndex}: ${ctx.stepTitle}.`,
    '',
    'PHASE: READ-ONLY ARBITRATION.',
    'You MUST NOT modify any code, tests, plan, or config. Your sole output is a single `result.json` file describing the ruling.',
    '',
    '## CONTEXT',
    '',
    WORKSPACE_CONSTRAINTS,
    '',
    `Working directory: ${ctx.cwd}`,
    `Step: ${ctx.stepIndex} — ${ctx.stepTitle}`,
    '',
    'The orchestrator ran a trailing re-review pass after all fix iterations had already completed. No fixer ran in this pass — there is no fix result to weigh. You are ruling on the review finding alone. The reviewer reports a non-passing verdict. You must rule whether this finding is correct (or that the evidence is inconclusive).',
    '',
    '## INPUTS',
    '',
    typecheckSection,
    '',
    '### Plan task body (the source of truth)',
    '```',
    inputs.taskBody,
    '```',
    '',
    '### Most-recent spec-review result.json (excerpt)',
    '```json',
    inputs.specExcerpt || '(empty)',
    '```',
    '',
    '### Most-recent quality-review result.json (excerpt)',
    '```json',
    inputs.qualityExcerpt || '(empty)',
    '```',
    '',
    '## DECISION FRAMEWORK',
    'Pick exactly one of these outcomes:',
    '- **finding_valid** — the reviewer is right; a real defect remains. Cite the typecheck error, the spec-review finding, or the plan task body that proves it.',
    '- **finding_invalid** — the reviewer is wrong; no defect exists. Cite the typecheck pass, the plan task body, or external evidence that disproves the finding.',
    '- **ambiguous** — both interpretations are defensible from the available artifacts. Cite what each side claims.',
    '- **insufficient_evidence** — the artifacts are unreadable or absent. Cite what is missing.',
    '',
    'Deterministic signals (use them, do not re-derive):',
    '- Typecheck PASS and the reviewer only cites style → finding_invalid.',
    '- Findings that contradict the verbatim plan task body → finding_invalid.',
    '- Findings that match the verbatim plan task body verbatim → finding_valid.',
    '',
    '## OUTPUT',
    'Write a single file named `result.json` at the working-directory root with this exact shape (no extra keys, no comments):',
    '```json',
    '{',
    '  "outcome": "finding_valid | finding_invalid | ambiguous | insufficient_evidence",',
    '  "defect_classification": "<P0..P3 | omitted when N/A>",',
    '  "evidence": "<non-empty: the specific artifact or finding that supports your ruling>",',
    '  "rationale": "<non-empty: your reasoning, in one paragraph>"',
    '}',
    '```',
    'Rules:',
    '- `evidence` MUST be non-empty. The orchestrator treats empty evidence as a hard failure and escalates to a human.',
    '- Do NOT re-run typecheck, lint, or tests.',
    '- Do NOT read additional files beyond the inputs above.',
    '- Do NOT write any code, scratch files, or modifications to the repo.',
    'STOP RULE: as soon as `result.json` is written, end your turn.',
  ].join('\n');
}

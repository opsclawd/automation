import type { TypecheckResult } from '@ai-sdlc/application';

export interface BuildArbiterPromptContext {
  stepIndex: number;
  stepTitle: string;
  cwd: string;
}

export interface BuildArbiterPromptInputs {
  tcResult: TypecheckResult;
  /** Most-recent spec-review result.json excerpt (first ~4 KB). */
  specExcerpt: string;
  /** Most-recent fix result.json excerpt (first ~4 KB). */
  fixExcerpt: string;
  /** The fix agent's free-text rebuttal (may be empty). */
  fixRebuttal: string;
  /** The plan.md body of this Task N (e.g. `extractTaskBody` output). */
  taskBody: string;
}

export function buildArbiterPrompt(
  ctx: BuildArbiterPromptContext,
  inputs: BuildArbiterPromptInputs,
): string {
  const typecheckSection =
    inputs.tcResult.outcome === 'pass'
      ? '## TYPECHECK RESULT\nThe orchestrator ran `pnpm -r typecheck` after implement completed.\nResult: PASS\n\nThe typecheck is green. Treat typecheck-valid code as objectively correct unless you find explicit evidence of a different defect.'
      : `## TYPECHECK RESULT\nThe orchestrator ran \`pnpm -r typecheck\` after implement completed.\nResult: FAIL\n\nTypecheck errors:\n\`\`\`\n${inputs.tcResult.output}\n\`\`\`\n\nNote: a typecheck failure is usually OBJECTIVE EVIDENCE — when present, prefer finding_valid.`;

  return [
    '# TASK',
    `You are arbitrating a review/fix contradiction for step ${ctx.stepIndex}: ${ctx.stepTitle}.`,
    '',
    'PHASE: READ-ONLY ARBITRATION.',
    'You MUST NOT modify any code, tests, plan, or config. Your sole output is a single `result.json` file describing the ruling.',
    '',
    '## CONTEXT',
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
    inputs.taskBody,
    '```',
    '',
    '### Most-recent spec-review result.json (excerpt)',
    '```json',
    inputs.specExcerpt || '(empty)',
    '```',
    '',
    '### Most-recent fix result.json (excerpt)',
    '```json',
    inputs.fixExcerpt || '(empty)',
    '```',
    '',
    '### Fixer rebuttal (verbatim)',
    inputs.fixRebuttal || '(no rebuttal provided)',
    '',
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
    '- Findings that match the plan task body verbatim and the fix ignored them → finding_valid.',
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

import { ArtifactNotFoundError, type ArtifactStore, WORKSPACE_CONSTRAINTS } from '@ai-sdlc/application';

export const PLAN_REVIEW_FINDINGS_ARTIFACT = 'plan-review-findings.md';
export const PLAN_FIX_RESULT_ARTIFACT = 'plan-fix-result.json';
export const PLAN_REVIEW_ARBITER_RESULT_ARTIFACT = 'plan-review-arbiter-result.json';

async function readExcerpt(
  artifacts: ArtifactStore,
  runId: string,
  relativePath: string,
): Promise<string> {
  try {
    return await artifacts.read(runId, relativePath);
  } catch (err) {
    if (!(err instanceof ArtifactNotFoundError)) throw err;
    return '';
  }
}

export async function readPlanReviewExcerpts(
  artifacts: ArtifactStore,
  runId: string,
): Promise<{ planExcerpt: string; findingsExcerpt: string; fixExcerpt: string }> {
  return {
    planExcerpt: await readExcerpt(artifacts, runId, 'plan.md'),
    findingsExcerpt: await readExcerpt(artifacts, runId, PLAN_REVIEW_FINDINGS_ARTIFACT),
    fixExcerpt: await readExcerpt(artifacts, runId, PLAN_FIX_RESULT_ARTIFACT),
  };
}

export async function readPlanReviewFinalExcerpts(
  artifacts: ArtifactStore,
  runId: string,
): Promise<{ planExcerpt: string; findingsExcerpt: string }> {
  return {
    planExcerpt: await readExcerpt(artifacts, runId, 'plan.md'),
    findingsExcerpt: await readExcerpt(artifacts, runId, PLAN_REVIEW_FINDINGS_ARTIFACT),
  };
}

export interface BuildPlanReviewArbiterPromptContext {
  cwd: string;
  runId: string;
}

export interface BuildPlanReviewArbiterPromptInputs {
  planExcerpt: string;
  findingsExcerpt: string;
  fixExcerpt: string;
  fixRebuttal: string;
}

export function buildPlanReviewArbiterPrompt(
  ctx: BuildPlanReviewArbiterPromptContext,
  inputs: BuildPlanReviewArbiterPromptInputs,
): string {
  return [
    '# TASK',
    'You are arbitrating a plan-review / plan-fix contradiction.',
    '',
    'PHASE: READ-ONLY ARBITRATION.',
    'You MUST NOT modify any code, plan, or config. Your sole output is a single `result.json` file describing the ruling.',
    '',
    '## CONTEXT',
    '',
    WORKSPACE_CONSTRAINTS,
    '',
    `Working directory: ${ctx.cwd}`,
    `Run: ${ctx.runId}`,
    '',
    'The orchestrator ran a plan-review / plan-fix iteration. The reviewer reports a P1 defect (p1_found) while the fixer reports done_no_fixes_needed. You must rule which side is correct (or that the evidence is inconclusive).',
    '',
    '## INPUTS',
    '### plan.md (excerpt)',
    '```',
    inputs.planExcerpt || '(empty)',
    '```',
    '',
    '### plan-review-findings.md (excerpt)',
    '```',
    inputs.findingsExcerpt || '(empty)',
    '```',
    '',
    '### plan-fix-result.json (excerpt)',
    '```json',
    inputs.fixExcerpt || '(empty)',
    '```',
    '',
    '### Fixer rebuttal (verbatim)',
    inputs.fixRebuttal || '(no rebuttal provided)',
    '',
    '## DECISION FRAMEWORK',
    'Pick exactly one of these outcomes:',
    '- **finding_valid** — the reviewer is right; the plan has a real defect. Cite the plan section or finding that proves it.',
    '- **finding_invalid** — the reviewer is wrong; the plan is correct and no defect exists. Cite the plan section that disproves the finding.',
    '- **ambiguous** — both interpretations are defensible. Cite what each side claims.',
    '- **insufficient_evidence** — the artifacts are unreadable or absent. Cite what is missing.',
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
    '- Do NOT read additional files beyond the inputs above.',
    '- Do NOT write any code, scratch files, or modifications to the repo.',
    'STOP RULE: as soon as `result.json` is written, end your turn.',
  ].join('\n');
}

export interface BuildPlanReviewFinalReviewArbiterPromptInputs {
  planExcerpt: string;
  findingsExcerpt: string;
}

export function buildPlanReviewFinalReviewArbiterPrompt(
  ctx: BuildPlanReviewArbiterPromptContext,
  inputs: BuildPlanReviewFinalReviewArbiterPromptInputs,
): string {
  return [
    '# TASK',
    'You are arbitrating a plan-review trailing final-review finding.',
    '',
    'PHASE: READ-ONLY ARBITRATION.',
    'You MUST NOT modify any code, plan, or config. Your sole output is a single `result.json` file describing the ruling.',
    '',
    '## CONTEXT',
    '',
    WORKSPACE_CONSTRAINTS,
    '',
    `Working directory: ${ctx.cwd}`,
    `Run: ${ctx.runId}`,
    '',
    'The orchestrator ran a trailing final review after all fix iterations had already completed. No fixer ran in this pass — there is no fix result to weigh. The reviewer reports a non-passing verdict on the plan. You must rule whether this finding is correct (or that the evidence is inconclusive).',
    '',
    '## INPUTS',
    '### plan.md (excerpt)',
    '```',
    inputs.planExcerpt || '(empty)',
    '```',
    '',
    '### plan-review-findings.md (excerpt, this pass)',
    '```',
    inputs.findingsExcerpt || '(empty)',
    '```',
    '',
    '## DECISION FRAMEWORK',
    'Pick exactly one of these outcomes:',
    '- **finding_valid** — the reviewer is right; the plan has a real defect. Cite the plan section or finding that proves it.',
    '- **finding_invalid** — the reviewer is wrong; the plan is correct and no defect exists. Cite the plan section that disproves the finding.',
    '- **ambiguous** — both interpretations are defensible. Cite what each side claims.',
    '- **insufficient_evidence** — the artifacts are unreadable or absent. Cite what is missing.',
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
    '- Do NOT read additional files beyond the inputs above.',
    '- Do NOT write any code, scratch files, or modifications to the repo.',
    'STOP RULE: as soon as `result.json` is written, end your turn.',
  ].join('\n');
}

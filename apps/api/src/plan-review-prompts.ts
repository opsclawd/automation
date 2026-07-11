import { execFileSync } from 'node:child_process';
import { ArtifactNotFoundError, WORKSPACE_CONSTRAINTS } from '@ai-sdlc/application';
import type {
  PlanReviewFinding,
  PlanReviewStepOptions,
  EvidenceResolver,
  ArtifactStore,
} from '@ai-sdlc/application';
import { parseTaskManifest } from '@ai-sdlc/application';

export { parsePlanReviewFindings } from '@ai-sdlc/application/plan-review/parse-plan-review-findings';
export type { PlanReviewFinding, PlanReviewStepOptions, EvidenceResolver };

export const PLAN_REVIEW_FINDINGS_ARTIFACT = 'plan-review-findings.md';
export const PLAN_FIX_RESULT_ARTIFACT = 'plan-fix-result.json';
export const PLAN_REVIEW_ARBITER_RESULT_ARTIFACT = 'plan-review-arbiter-result.json';

export function buildPlanReviewFixPrompt(
  basePrompt: string,
  opts?: { deterministicDiagnostic?: string | undefined },
): string {
  if (!opts?.deterministicDiagnostic) return basePrompt;
  return [
    basePrompt,
    '',
    '## DETERMINISTIC DIAGNOSTIC',
    'A deterministic failure or manifest mismatch was detected:',
    '```',
    opts.deterministicDiagnostic.slice(0, 8192),
    '```',
    '',
    'You MUST resolve this deterministic failure before performing other work.',
  ].join('\n');
}

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

export function buildPlanReviewReviewPrompt(
  basePrompt: string,
  opts?: PlanReviewStepOptions,
): string {
  if (opts === undefined) return basePrompt;
  const scopeBlock = buildPlanReviewReviewScopeBlock(opts);
  if (!scopeBlock) return basePrompt;
  return [basePrompt, scopeBlock].join('\n\n');
}

/**
 * Render the SCOPE + DISPOSITION GUIDANCE block for the plan-review
 * reviewer's iteration >= 2 prompt (#716). This block is APPENDED to the
 * base prompt rendered from `prompts/plan-review/plan-review.md`; it is
 * NEVER a replacement for the base prompt. The base prompt already
 * includes `plan.md`/`design.md`/`task-manifest.json` artifact references
 * and the WORKSPACE_CONSTRAINTS block — substituting it would discard
 * those and break the reviewer's ability to evaluate the plan itself.
 */
export function buildPlanReviewReviewScopeBlock(opts?: PlanReviewStepOptions): string {
  if (opts === undefined) return '';
  const prevFindings = opts.prevFindings ?? [];
  const recentFixCitations = opts.recentFixCitations ?? [];
  const sections: string[] = [];
  const hasNoThreadedInputs = prevFindings.length === 0 && recentFixCitations.length === 0;

  sections.push(
    '## SCOPE',
    'You are reviewing changes within an automated plan-review/fix loop.',
    'Your review is scoped to:',
    '1. The disposition of the prior finding set (frozen at iteration 1).',
    '2. New findings whose citation references text introduced by the most recent fix.',
    '',
    'Out of scope: brand-new findings about pre-existing plan prose that was NOT',
    'modified by the most recent fix. The orchestrator will drop these from verdict',
    'computation; do not waste finding slots on them. If you find a defect in such',
    'prose, surface it under the `## noted_but_out_of_scope` heading (informational only).',
    ...(hasNoThreadedInputs
      ? [
          '',
          'Even though no prior findings or recent fix citations were threaded, this pass',
          'is still delta-scoped. Do NOT fall back to a full-plan review just because the',
          'scoped inputs are empty.',
        ]
      : []),
    '',
    '## DISPOSITION GUIDANCE',
    prevFindings.length > 0
      ? 'For each prior finding below, mark one disposition:'
      : 'No frozen findings were produced in iteration 1.',
    prevFindings.length > 0
      ? '- `addressed by fix` — the defect is gone in the current plan.'
      : 'Use the recent fix citations below to scope any new findings.',
    prevFindings.length > 0
      ? '- `still open` — the defect persists; re-flag with the SAME citation.'
      : '',
    prevFindings.length > 0
      ? '- `rebutted by fixer` — the fixer asserted no change was needed; confirm against the current plan.'
      : '',
    '',
    ...(prevFindings.length > 0
      ? [
          '### Frozen findings (from iteration 1)',
          ...prevFindings.map(
            (f) =>
              `- [${f.severity}] \`${f.citation}\` | ${f.failureScenario} | prior disposition: ${f.disposition ?? 'still_open'} | prior evidence: ${f.evidence}`,
          ),
          '',
        ]
      : []),
  );

  if (recentFixCitations.length > 0) {
    sections.push(
      '## RECENT FIX CITATIONS',
      'The most recent fix invocation modified text at the following citations.',
      'New findings targeting these citations are eligible to count toward the verdict:',
      ...recentFixCitations.map((c) => `- \`${c}\``),
      '',
    );
  } else if (!hasNoThreadedInputs) {
    sections.push(
      '## RECENT FIX CITATIONS',
      'No citations were recorded for the most recent fix invocation.',
      '',
    );
  }

  return sections.join('\n');
}

/**
 * Build an `EvidenceResolver` (#716, design §3.6) bound to the run's
 * artifact store. Resolves:
 *   - `plan.md:N` / `plan.md:N-M` → exists iff the line range falls
 *     inside the current `plan.md` artifact.
 *   - `task-manifest.json:Task N` → exists iff task N (with `n === N`)
 *     appears in the manifest's `tasks[]`. Uses `parseTaskManifest` from
 *     `packages/application/src/phases/plan-tasks.ts` — which validates
 *     the schema and reads entries' `n` field, NOT `index` (fix to
 *     reviewer finding #3).
 *   - `design.md:N.M` (NO `§` prefix) → exists iff the design doc has a
 *     markdown heading matching `^#{2,3}\s+(N\.M[^:]*)$` (e.g.
 *     `### 3.1 Layer summary`, `### 7.5 Risk: ...`). Does NOT search for
 *     `§N.M` because the repo's design.md uses plain numbered headings
 *     (fix to reviewer finding #4).
 *
 * Any citation that fails to resolve is `ungrounded`; an ungrounded P0/P1
 * cannot drive `p1_found` per AC #3.
 */
export function createPlanReviewEvidenceResolver(
  artifacts: ArtifactStore,
  runId: string,
): EvidenceResolver {
  return async (finding): Promise<boolean> => {
    const citation = finding.citation;
    if (!citation) return false;

    // plan.md:N or plan.md:N-M
    const planMatch = /^plan\.md:(\d+)(?:-(\d+))?$/.exec(citation);
    if (planMatch) {
      try {
        const plan = await artifacts.read(runId, 'plan.md');
        const lines = plan.split('\n');
        const start = parseInt(planMatch[1]!, 10);
        const end = planMatch[2] ? parseInt(planMatch[2], 10) : start;
        return start >= 1 && start <= end && end <= lines.length;
      } catch {
        return false;
      }
    }

    // task-manifest.json:Task N — uses `n` field (NOT `index`)
    const taskMatch = /^task-manifest\.json:Task\s+(\d+)$/.exec(citation);
    if (taskMatch) {
      try {
        const manifest = await artifacts.read(runId, 'task-manifest.json');
        const parsed = parseTaskManifest(manifest);
        if (!parsed.success) return false;
        const target = parseInt(taskMatch[1]!, 10);
        return parsed.manifest.tasks.some((t) => t.n === target);
      } catch {
        return false;
      }
    }

    // design.md:N.M — matches plain markdown headings like
    // `### 3.1 Layer summary` or `## 7.5 Risk: #704's bonus fix interaction`.
    // NO `§` prefix (fix to reviewer finding #4).
    const designMatch = /^design\.md:(\d+(?:\.\d+)*)$/.exec(citation);
    if (designMatch) {
      try {
        const design = await artifacts.read(runId, 'design.md');
        const sectionNumber = designMatch[1]!;
        const escaped = sectionNumber.replace(/\./g, '\\.');
        const headingRe = new RegExp(`^#{2,3}\\s+${escaped}(?:\\s+.*)?$`, 'm');
        return headingRe.test(design);
      } catch {
        return false;
      }
    }

    return false;
  };
}

/**
 * Compute citations for text introduced by the most recent fix invocation
 * (#716, design §2.5 / §7.1). Returns line ranges from
 * `git diff <headBeforeFix>..HEAD -- plan.md` as `plan.md:N` or
 * `plan.md:N-M` citations.
 *
 * Used by the composition-root adapter to supply the
 * `computeLastFixDiffCitations` dep on `PlanReviewLoopDeps`. Returns an
 * empty array on git failure — when no `headBeforeFix` is provided, or
 * the diff fails to compute, the loop defaults `lastFixDiffCitations` to
 * `[]`, which means every new finding from the next reviewer is
 * classified `out_of_scope` (the safe default per reviewer finding #1:
 * never promote a citation to in-scope without proof the fix touched it).
 */
export function getRecentFixCitations(cwd: string, headBeforeFix: string | undefined): string[] {
  if (!headBeforeFix) return [];
  try {
    const diff = execFileSync(
      'git',
      ['diff', '--unified=0', `${headBeforeFix}..HEAD`, '--', 'plan.md'],
      { cwd, encoding: 'utf-8', maxBuffer: 1024 * 1024 },
    );
    return parsePlanDiffCitations(diff);
  } catch {
    return [];
  }
}

/**
 * Parse a unified diff hunk header (`@@ -a,b +c,d @@`) into `plan.md:N` or
 * `plan.md:N-M` citations. Pure; used by `getRecentFixCitations`.
 * Skips empty/delete-only hunks where count <= 0.
 */
function parsePlanDiffCitations(diff: string): string[] {
  const citations: string[] = [];
  const hunkRe = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/gm;
  let m: RegExpExecArray | null;
  while ((m = hunkRe.exec(diff)) !== null) {
    const start = parseInt(m[1]!, 10);
    const count = m[2] ? parseInt(m[2], 10) : 1;
    if (count <= 0) {
      continue;
    }
    if (count === 1) {
      citations.push(`plan.md:${start}`);
    } else {
      citations.push(`plan.md:${start}-${start + count - 1}`);
    }
  }
  return citations;
}

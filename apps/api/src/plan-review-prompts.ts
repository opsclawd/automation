import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ArtifactNotFoundError,
  WORKSPACE_CONSTRAINTS,
  SCRATCH_FILE_POLICY,
} from '@ai-sdlc/application';
import type {
  PlanReviewFinding,
  PlanReviewStepOptions,
  PlanReviewSnapshot,
  EvidenceResolver,
  ArtifactStore,
} from '@ai-sdlc/application';
import { parseTaskManifest } from '@ai-sdlc/application';
import { getHydratedWorktreePath } from '@ai-sdlc/application/ports';

export { parsePlanReviewFindings } from '@ai-sdlc/application/plan-review/parse-plan-review-findings';
export type { PlanReviewFinding, PlanReviewStepOptions, PlanReviewSnapshot, EvidenceResolver };

export const PLAN_REVIEW_FINDINGS_ARTIFACT = 'plan-review-findings.md';
export const PLAN_FIX_RESULT_ARTIFACT = 'plan-fix-result.json';
export const PLAN_REVIEW_ARBITER_RESULT_ARTIFACT = 'plan-review-arbiter-result.json';

export function buildPlanReviewFixPrompt(
  basePrompt: string,
  opts?: {
    deterministicDiagnostic?: string | undefined;
    isTerminalFix?: boolean;
    historyContext?: string;
  },
): string {
  let prompt = basePrompt;
  if (!prompt.includes(SCRATCH_FILE_POLICY)) {
    prompt = [prompt, '', '## SCRATCH WORKSPACE POLICY', '', SCRATCH_FILE_POLICY].join('\n');
  }

  if (opts?.deterministicDiagnostic) {
    prompt = [
      prompt,
      '',
      '## DETERMINISTIC DIAGNOSTIC',
      'A deterministic failure or manifest mismatch was detected:',
      '```',
      opts.deterministicDiagnostic.slice(0, 8192),
      '```',
      '',
      'You MUST resolve this deterministic failure before performing other work.',
      'CRITICAL: If you believe this diagnostic is already resolved, you MUST explicitly',
      're-run, search, or grep your working tree to verify that the listed files, lines,',
      'or symbols are actually declared and correctly synchronized in task-manifest.json',
      'and plan.md. Do not assume or assert it is resolved without verifying directly.',
    ].join('\n');
  }

  if (opts?.isTerminalFix) {
    const parts = [
      prompt,
      '',
      '## TERMINAL ATTEMPT — FINAL PLAN REPAIR',
      '',
      'There will be no further semantic review/fix round. Address every open',
      'finding coherently, re-derive affected plan sections instead of',
      'point-patching them, keep plan.md and task-manifest.json synchronized,',
      'and leave the plan structurally valid.',
    ];

    if (opts.historyContext) {
      parts.push('', '## PLAN REVIEW HISTORY', '', opts.historyContext);
    }

    prompt = parts.join('\n');
  }

  return prompt;
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
): Promise<{
  planExcerpt: string;
  findingsExcerpt: string;
  fixExcerpt: string;
  manifestExcerpt: string;
  designExcerpt: string;
  issueExcerpt: string;
}> {
  return {
    planExcerpt: await readExcerpt(artifacts, runId, 'plan.md'),
    findingsExcerpt: await readExcerpt(artifacts, runId, PLAN_REVIEW_FINDINGS_ARTIFACT),
    fixExcerpt: await readExcerpt(artifacts, runId, PLAN_FIX_RESULT_ARTIFACT),
    manifestExcerpt: await readExcerpt(artifacts, runId, 'task-manifest.json'),
    designExcerpt: await readExcerpt(artifacts, runId, 'design.md'),
    issueExcerpt: await readExcerpt(artifacts, runId, 'issue.md'),
  };
}

export async function readPlanReviewFinalExcerpts(
  artifacts: ArtifactStore,
  runId: string,
): Promise<{
  planExcerpt: string;
  findingsExcerpt: string;
  manifestExcerpt: string;
  designExcerpt: string;
  issueExcerpt: string;
}> {
  return {
    planExcerpt: await readExcerpt(artifacts, runId, 'plan.md'),
    findingsExcerpt: await readExcerpt(artifacts, runId, PLAN_REVIEW_FINDINGS_ARTIFACT),
    manifestExcerpt: await readExcerpt(artifacts, runId, 'task-manifest.json'),
    designExcerpt: await readExcerpt(artifacts, runId, 'design.md'),
    issueExcerpt: await readExcerpt(artifacts, runId, 'issue.md'),
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
  manifestExcerpt?: string;
  designExcerpt?: string;
  issueExcerpt?: string;
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
    '### task-manifest.json (excerpt)',
    '```json',
    inputs.manifestExcerpt || '(empty)',
    '```',
    '',
    '### design.md (excerpt)',
    '```',
    inputs.designExcerpt || '(empty)',
    '```',
    '',
    '### Fixer rebuttal (verbatim)',
    inputs.fixRebuttal || '(no rebuttal provided)',
    '',
    '## GROUNDING CONTRACT',
    '- Any claim about existing plan.md or task-manifest.json content MUST include the exact source text as <quote>exact text from plan.md or task-manifest.json</quote>.',
    '- For `finding_valid`, include at least one non-empty <quote>...</quote> block in `evidence` or `rationale`; use multiple blocks when the ruling depends on multiple passages.',
    '- Every tagged quote will be mechanically verified against plan.md and task-manifest.json after whitespace normalization.',
    '- A `finding_valid` result with no tagged quote, an empty tagged quote, or any quote absent from both sources is automatically treated as `finding_invalid`.',
    '- Quotes from findings, design, or the fixer rebuttal may provide context but do not satisfy the plan/manifest grounding requirement.',
    '',
    '## DECISION FRAMEWORK',
    'Pick exactly one of these outcomes:',
    '- **finding_valid** — the reviewer is right; the plan has a real defect. You MUST include at least one non-empty <quote>exact text from plan.md or task-manifest.json</quote> in `evidence` or `rationale` that proves the defect.',
    '- **finding_invalid** — the reviewer is wrong; the plan is correct and no defect exists. Cite the plan section or task-manifest.json task that disproves the finding.',
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
  manifestExcerpt?: string;
  designExcerpt?: string;
  issueExcerpt?: string;
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
    '### task-manifest.json (excerpt)',
    '```json',
    inputs.manifestExcerpt || '(empty)',
    '```',
    '',
    '### design.md (excerpt)',
    '```',
    inputs.designExcerpt || '(empty)',
    '```',
    '',
    '## GROUNDING CONTRACT',
    '- Any claim about existing plan.md or task-manifest.json content MUST include the exact source text as <quote>exact text from plan.md or task-manifest.json</quote>.',
    '- For `finding_valid`, include at least one non-empty <quote>...</quote> block in `evidence` or `rationale`; use multiple blocks when the ruling depends on multiple passages.',
    '- Every tagged quote will be mechanically verified against plan.md and task-manifest.json after whitespace normalization.',
    '- A `finding_valid` result with no tagged quote, an empty tagged quote, or any quote absent from both sources is automatically treated as `finding_invalid`.',
    '- Quotes from findings, design, or the fixer rebuttal may provide context but do not satisfy the plan/manifest grounding requirement.',
    '',
    '## DECISION FRAMEWORK',
    'Pick exactly one of these outcomes:',
    '- **finding_valid** — the reviewer is right; the plan has a real defect. You MUST include at least one non-empty <quote>exact text from plan.md or task-manifest.json</quote> in `evidence` or `rationale` that proves the defect.',
    '- **finding_invalid** — the reviewer is wrong; the plan is correct and no defect exists. Cite the plan section or task-manifest.json task that disproves the finding.',
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

export function buildPlanReviewValidationErrorBlock(diagnostic?: string): string {
  if (!diagnostic || diagnostic.trim().length === 0) {
    return '';
  }
  const sanitized = diagnostic.slice(0, 8192).replace(/```/g, "'''");
  return [
    '## Output Validation Failure',
    '',
    'Your previous response was rejected by the system. Correct the response and write a replacement findings artifact.',
    '',
    '```text',
    sanitized,
    '```',
  ].join('\n');
}

export function buildPlanReviewReviewPrompt(
  basePrompt: string,
  opts?: PlanReviewStepOptions,
  validationError?: string,
): string {
  const scopeBlock = opts ? buildPlanReviewReviewScopeBlock(opts) : '';
  const validationBlock = buildPlanReviewValidationErrorBlock(validationError);
  let prompt = basePrompt;
  if (scopeBlock) {
    prompt = `${prompt}\n\n${scopeBlock}`;
  }
  if (validationBlock) {
    prompt = `${prompt}\n\n${validationBlock}`;
  }
  if (prompt.includes(SCRATCH_FILE_POLICY)) return prompt;
  return [prompt, '', '## SCRATCH WORKSPACE POLICY', '', SCRATCH_FILE_POLICY].join('\n');
}

/**
 * Render the SCOPE + DISPOSITION GUIDANCE block for the plan-review
 * reviewer (#716, #723). This block is APPENDED to the base prompt
 * rendered from `prompts/plan-review/plan-review.md`; it is NEVER a
 * replacement for the base prompt. The base prompt already includes
 * `plan.md`/`design.md`/`task-manifest.json` artifact references and
 * the WORKSPACE_CONSTRAINTS block — substituting it would discard those
 * and break the reviewer's ability to evaluate the plan itself.
 *
 * Mode-specific behavior (#723):
 *   - `initial_full`: no scope block (first discovery pass)
 *   - `intermediate_delta`: scoped to frozen findings + recent-fix citations
 *   - `final_full`: full review against snapshot; no recent-fix citation filter
 */
export function buildPlanReviewReviewScopeBlock(opts?: PlanReviewStepOptions): string {
  if (opts === undefined) return '';

  // final_full mode: render a full-review scope block with snapshot context.
  if (opts.mode === 'final_full') {
    const sections: string[] = [];
    sections.push(
      '## REVIEW MODE: FINAL FULL',
      '',
      'This is a final full review after delta convergence. Inspect the complete',
      'plan scope without any delta-scoped restrictions.',
      '',
    );
    if (opts.snapshot) {
      sections.push(
        '### ARTIFACT SNAPSHOT',
        `plan.md digest: ${opts.snapshot.planMdDigest}`,
        `manifest digest: ${opts.snapshot.manifestDigest ?? '(none)'}`,
        `design digest: ${opts.snapshot.designDigest ?? '(none)'}`,
        `captured at: ${opts.snapshot.capturedAt}`,
        '',
      );
    }
    sections.push(
      '## SCOPE',
      'Full plan review: all findings are eligible, regardless of prior frozen set',
      'or recent-fix citations. The reviewer should re-check the complete plan',
      'and verify manifest synchronization.',
      '',
    );
    return sections.join('\n');
  }

  // initial_full mode: no scope block needed.
  if (opts.mode === 'initial_full') {
    return '';
  }

  // intermediate_delta mode: render delta-scoped block.
  const prevFindings = opts.prevFindings ?? [];
  const recentFixCitations = opts.recentFixCitations ?? [];
  const sections: string[] = [];
  const hasNoThreadedInputs = prevFindings.length === 0 && recentFixCitations.length === 0;

  sections.push(
    '## REVIEW MODE: INTERMEDIATE DELTA',
    '',
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
 * (#716, design §2.5 / §7.1; rewritten for #1027; path updated for #1080).
 * Returns line ranges from a plain content diff between `planMdBeforeFix`
 * (the full text of plan.md captured immediately before the fix ran) and
 * the CURRENT plan.md file on disk, as `plan.md:N` or `plan.md:N-M`
 * citations.
 *
 * plan.md is gitignored/untracked (`.gitignore:/.ai/`) — it is written
 * via the artifact store's `write()`, never via `git commit`. After the
 * artifact store's `hydrateWorktree` (#1080) it lives at
 * `<worktree>/.ai/plan.md` rather than the worktree root, so the
 * canonical on-disk path is derived via `getHydratedWorktreePath`.
 * The original implementation computed `git diff <sha>..HEAD -- plan.md`,
 * which is always empty for an untracked path regardless of real content
 * changes, since git has no history for it at any commit. That caused
 * `recentFixCitations` to always be `[]`, which — combined with
 * `prevFindings` being frozen at iteration 1 — could make the
 * `intermediate_delta` scope block (and sometimes the whole rendered
 * prompt) byte-identical across iterations even after a genuine fix,
 * triggering plan-review's semantic-retry dedup to suppress a genuinely
 * new review as a duplicate of the pre-fix one (#1027).
 *
 * This diffs two file contents directly via `git diff --no-index`, which
 * works regardless of git tracking status: the "before" text is written
 * to a temp file and compared against the live worktree file.
 *
 * Used by the composition-root adapter to supply the
 * `computeLastFixDiffCitations` dep on `PlanReviewLoopDeps`. Returns an
 * empty array when `planMdBeforeFix` is undefined (fixer failure, no fix
 * this iteration) or the diff fails to compute — every new finding from
 * the next reviewer is then classified `out_of_scope` (the safe default
 * per reviewer finding #1: never promote a citation to in-scope without
 * proof the fix touched it).
 */
export function getRecentFixCitations(cwd: string, planMdBeforeFix: string | undefined): string[] {
  if (planMdBeforeFix === undefined) return [];
  const tempPath = join(tmpdir(), `plan-review-before-fix-${randomUUID()}.md`);
  try {
    writeFileSync(tempPath, planMdBeforeFix, 'utf-8');
    let diff: string;
    try {
      diff = execFileSync(
        'git',
        [
          'diff',
          '--no-index',
          '--unified=0',
          tempPath,
          join(cwd, getHydratedWorktreePath('plan.md')),
        ],
        { cwd, encoding: 'utf-8', maxBuffer: 1024 * 1024 },
      );
    } catch (err) {
      // `git diff --no-index` exits 1 (not an error condition) whenever it
      // finds differences — execFileSync throws on any non-zero exit, so
      // recover stdout from the thrown error in that specific case rather
      // than treating a real diff as a failure.
      const execErr = err as { status?: number; stdout?: unknown };
      if (execErr.status === 1 && typeof execErr.stdout === 'string') {
        diff = execErr.stdout;
      } else {
        return [];
      }
    }
    return parsePlanDiffCitations(diff);
  } catch {
    return [];
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {}
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

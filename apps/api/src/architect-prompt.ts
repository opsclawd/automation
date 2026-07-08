/**
 * Builds the read-only architect prompt.
 *
 * The architect analyzes the review manifest as a whole and produces
 * `review-fix-plan.json` — a per-task `approach`/`constraints`/
 * `conflicts_resolved`/`depends_on` plan the fixer consumes via
 * `ArchitectPlan`. The prompt is the TS port of the legacy
 * `ARCHITECT_PROMPT` constant at
 * `scripts/legacy/ai-run-issue-v2:4350-4390`.
 *
 * CRITICAL RULES (mirrored in the prompt body and the executor's
 * mutation guard — see design.md#d4):
 *   - Do NOT modify any code files.
 *   - Do NOT run git commands other than `git diff HEAD`.
 *   - Output ONLY `review-fix-plan.json`.
 *   - Stop after writing the file.
 */
export interface BuildArchitectPromptContext {
  cwd: string;
  repoId: string;
}

export interface BuildArchitectPromptInputs {
  manifest: string;
  reviewMd: string;
  triageMd: string;
}

export function buildArchitectPrompt(
  ctx: BuildArchitectPromptContext,
  inputs: BuildArchitectPromptInputs,
): string {
  let filteredManifest = inputs.manifest;
  try {
    const parsed = JSON.parse(inputs.manifest) as Record<string, unknown> | unknown[];
    const tasks = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && 'tasks' in parsed && Array.isArray(parsed.tasks)
        ? (parsed.tasks as unknown[])
        : [];
    const filteredTasks = tasks.filter((t) => {
      const item = t as Record<string, unknown> | null | undefined;
      return item?.action === 'fix' || item?.action == null;
    });
    filteredManifest = JSON.stringify(
      Array.isArray(parsed) ? filteredTasks : { tasks: filteredTasks },
      null,
      2,
    );
  } catch {
    // fallback to original manifest if parse fails
  }

  return [
    '# TASK',
    'You are a cohesive architect analyzing review findings before fix implementation.',
    '',
    'PHASE: READ-ONLY.',
    'You MUST NOT modify any code, tests, plan, or config. Your sole output is a single `review-fix-plan.json` file describing the cross-task fix plan.',
    '',
    '## CONTEXT',
    `Working directory: ${ctx.cwd}`,
    `Repository: ${ctx.repoId}`,
    '',
    '## INPUTS',
    'Read the following files:',
    '1. ./review-task-manifest.json — the full manifest of review findings',
    '2. ./review.md — the detailed code review',
    '3. ./review-triage.md — the triage summary',
    '',
    'Then run: `git diff HEAD`',
    '',
    '## MANIFEST (verbatim)',
    '```json',
    filteredManifest || '(empty)',
    '```',
    '',
    '### Review (excerpt)',
    '```',
    inputs.reviewMd || '(empty)',
    '```',
    '',
    '### Triage (excerpt)',
    '```',
    inputs.triageMd || '(empty)',
    '```',
    '',
    '## TASK',
    'Analyze ALL tasks with `action=fix` or `action=null`. For each task:',
    '1. Identify cross-task dependencies and constraint conflicts',
    '2. Produce a concrete fix approach that accounts for ALL constraints',
    '3. List specific constraints the fix must satisfy',
    '4. Note which other tasks this depends on (informational)',
    '',
    '## OUTPUT',
    'Write a single file named `review-fix-plan.json` at the working-directory root with this exact shape (no extra keys, no comments):',
    '```json',
    '{',
    '  "version": 1,',
    '  "tasks": [',
    '    {',
    '      "task_id": "<task_id from manifest>",',
    '      "approach": "<concrete fix strategy>",',
    '      "conflicts_resolved": ["<IDs of contradictions this resolves>"],',
    '      "constraints": ["<hard constraints the fix must satisfy>"],',
    '      "depends_on": ["<other task IDs this interacts with>"]',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'Only include tasks that have `action=fix` or `action=null`. Skip defer/skip tasks.',
    '',
    '## CRITICAL RULES',
    '- Do NOT modify any code files.',
    '- Do NOT run git commands other than `git diff HEAD`.',
    '- Output ONLY `review-fix-plan.json`.',
    '- Stop after writing the file.',
    '',
    'STOP RULE: as soon as `review-fix-plan.json` is written, end your turn.',
  ].join('\n');
}

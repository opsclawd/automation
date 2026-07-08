import { z } from 'zod';

/**
 * Zod schema for `review-fix-plan.json` — the artefact produced by the
 * `fix-review-architect` agent and consumed by the review-fix loop's
 * `architectPlan` input. Mirrors the legacy `jq -e '.version and
 * (.tasks | type == "array")'` shape validation in
 * `scripts/legacy/ai-run-issue-v2:4428`, expanded to enforce the
 * per-task contract the fixer relies on.
 *
 * This schema is the producer-side contract; the consumer-side type
 * is `ArchitectPlan` in `packages/application/src/review-fix/types.ts`.
 * Both are structurally compatible but represent different layers
 * (producer validation vs consumer input).
 */
export const architectPlanTaskSchema = z.object({
  task_id: z.string().trim().min(1, 'task_id is required'),
  approach: z.string().trim().min(1, 'approach is required'),
  conflicts_resolved: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  depends_on: z.array(z.string()).default([]),
});

export const architectPlanSchema = z.object({
  version: z.literal(1),
  tasks: z.array(architectPlanTaskSchema).min(1, 'at least one task is required'),
});

export type ArchitectPlanValidated = z.infer<typeof architectPlanSchema>;

import type { ZodTypeAny } from 'zod';
import { implementResultSchema } from './schemas/implement.js';
import { qualityReviewResultSchema } from './schemas/quality-review.js';
import { fixReviewResultSchema } from './schemas/fix-review.js';
import { createPrResultSchema } from './schemas/create-pr.js';
import { postPrReviewResultSchema } from './schemas/post-pr-review.js';
import { specReviewResultSchema } from './schemas/spec-review.js';
import { wholePrReviewResultSchema } from './schemas/whole-pr-review.js';
import { compoundResultSchema } from './schemas/compound.js';
import { arbiterResultSchema } from './schemas/arbiter.js';
import { fixValidateResultSchema } from './schemas/fix-validate.js';

export interface PhaseResultMeta {
  schema: ZodTypeAny;
  retrySafe: boolean;
}

// Temporary mapping from CANONICAL_PHASE_ORDER names to PHASE_RESULT_REGISTRY keys.
// Phases with no result entry (null) do not produce result.json artifacts.
// TODO: converge PHASE_RESULT_REGISTRY into CANONICAL_PHASE_ORDER so there's one source of truth.
export const PHASE_NAME_MIGRATION_MAP: Record<string, string | null> = {
  'plan-design': null,
  'plan-write': null,
  implement: 'implement',
  compound: 'compound',
  'create-pr': 'create-pr',
  'review-fix': null,
  read_issue: null,
  validate: null,
  'pr-review-poll': 'post-pr-review',
  'post-pr-review': null,
};

export const PHASE_RESULT_REGISTRY: Record<string, PhaseResultMeta> = {
  implement: { schema: implementResultSchema, retrySafe: false },
  'quality-review': { schema: qualityReviewResultSchema, retrySafe: true },
  // Retained as loop-internal routing schemas for agent invocation dispatch
  // within the review-fix phase (see design decision in design-decisions-report.md).
  // These are NOT reachable via PHASE_NAME_MIGRATION_MAP for result.json production.
  'fix-review': { schema: fixReviewResultSchema, retrySafe: false },
  'create-pr': { schema: createPrResultSchema, retrySafe: false },
  'post-pr-review': { schema: postPrReviewResultSchema, retrySafe: false },
  'spec-review': { schema: specReviewResultSchema, retrySafe: true },
  'whole-pr-review': { schema: wholePrReviewResultSchema, retrySafe: true },
  compound: { schema: compoundResultSchema, retrySafe: false },
  'fix-validate': { schema: fixValidateResultSchema, retrySafe: false },
  arbiter: { schema: arbiterResultSchema, retrySafe: true },
};

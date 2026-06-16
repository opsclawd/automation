import type { ZodTypeAny } from 'zod';
import { planDesignResultSchema } from './schemas/plan-design.js';
import { planWriteResultSchema } from './schemas/plan-write.js';
import { implementResultSchema } from './schemas/implement.js';
import { qualityReviewResultSchema } from './schemas/quality-review.js';
import { fixReviewResultSchema } from './schemas/fix-review.js';
import { createPrResultSchema } from './schemas/create-pr.js';
import { postPrReviewResultSchema } from './schemas/post-pr-review.js';
import { specReviewResultSchema } from './schemas/spec-review.js';
import { wholePrReviewResultSchema } from './schemas/whole-pr-review.js';
import { compoundResultSchema } from './schemas/compound.js';
import { fixValidateResultSchema } from './schemas/fix-validate.js';

export interface PhaseResultMeta {
  schema: ZodTypeAny;
  retrySafe: boolean;
}

// Temporary mapping from CANONICAL_PHASE_ORDER names to PHASE_RESULT_REGISTRY keys.
// Phases with no result entry (null) do not produce result.json artifacts.
// TODO: converge PHASE_RESULT_REGISTRY into CANONICAL_PHASE_ORDER so there's one source of truth.
export const PHASE_NAME_MIGRATION_MAP: Record<string, string | null> = {
  'plan-design': 'plan-design',
  'plan-write': 'plan-write',
  implement: 'implement',
  compound: 'compound',
  'create-pr': 'create-pr',
  'review-fix': 'fix-review',
  read_issue: null,
  validate: null,
  'pr-review-poll': null,
};

export const PHASE_RESULT_REGISTRY: Record<string, PhaseResultMeta> = {
  'plan-design': { schema: planDesignResultSchema, retrySafe: true },
  'plan-write': { schema: planWriteResultSchema, retrySafe: true },
  implement: { schema: implementResultSchema, retrySafe: false },
  'quality-review': { schema: qualityReviewResultSchema, retrySafe: true },
  'fix-review': { schema: fixReviewResultSchema, retrySafe: false },
  'create-pr': { schema: createPrResultSchema, retrySafe: false },
  'post-pr-review': { schema: postPrReviewResultSchema, retrySafe: false },
  'spec-review': { schema: specReviewResultSchema, retrySafe: true },
  'whole-pr-review': { schema: wholePrReviewResultSchema, retrySafe: true },
  compound: { schema: compoundResultSchema, retrySafe: false },
  'fix-validate': { schema: fixValidateResultSchema, retrySafe: false },
};

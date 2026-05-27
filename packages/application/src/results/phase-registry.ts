import type { ZodTypeAny } from 'zod';
import { planDesignResultSchema } from './schemas/plan-design.js';
import { planWriteResultSchema } from './schemas/plan-write.js';
import { implementResultSchema } from './schemas/implement.js';
import { reviewResultSchema } from './schemas/review.js';
import { fixReviewResultSchema } from './schemas/fix-review.js';
import { createPrResultSchema } from './schemas/create-pr.js';
import { prReviewPollResultSchema } from './schemas/pr-review-poll.js';
import { specReviewResultSchema } from './schemas/spec-review.js';
import { wholePrReviewResultSchema } from './schemas/whole-pr-review.js';
import { compoundResultSchema } from './schemas/compound.js';

export interface PhaseResultMeta {
  schema: ZodTypeAny;
  retrySafe: boolean;
}

export const PHASE_RESULT_REGISTRY: Record<string, PhaseResultMeta> = {
  'plan-design': { schema: planDesignResultSchema, retrySafe: true },
  'plan-write': { schema: planWriteResultSchema, retrySafe: true },
  implement: { schema: implementResultSchema, retrySafe: false },
  review: { schema: reviewResultSchema, retrySafe: true },
  'fix-review': { schema: fixReviewResultSchema, retrySafe: false },
  'create-pr': { schema: createPrResultSchema, retrySafe: false },
  'pr-review-poll': { schema: prReviewPollResultSchema, retrySafe: false },
  'spec-review': { schema: specReviewResultSchema, retrySafe: true },
  'whole-pr-review': { schema: wholePrReviewResultSchema, retrySafe: true },
  compound: { schema: compoundResultSchema, retrySafe: false },
};

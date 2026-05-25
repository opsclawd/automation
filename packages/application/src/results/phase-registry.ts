import type { ZodTypeAny } from 'zod';
import { planDesignResultSchema } from './schemas/plan-design.js';
import { implementResultSchema } from './schemas/implement.js';

export interface PhaseResultMeta {
  schema: ZodTypeAny;
  retrySafe: boolean;
}

export const PHASE_RESULT_REGISTRY: Record<string, PhaseResultMeta> = {
  'plan-design': { schema: planDesignResultSchema, retrySafe: true },
  implement: { schema: implementResultSchema, retrySafe: false },
};

import { z } from 'zod';

export const findingEvaluationSchema = z.object({
  finding: z.string().min(1),
  resolved: z.boolean(),
  evidence: z.string().min(1),
  rationale: z.string().optional(),
});

export const narrowVerificationResultSchema = z.object({
  verdict: z.enum(['PASS', 'FAIL', 'pass', 'fail']),
  findings_evaluations: z.array(findingEvaluationSchema).default([]),
  obvious_regressions: z.array(z.string()).default([]),
  summary: z.string().optional(),
});

export type FindingEvaluation = z.infer<typeof findingEvaluationSchema>;
export type NarrowVerificationResult = z.infer<typeof narrowVerificationResultSchema>;

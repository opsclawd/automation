import { z } from 'zod';

export const specReviewRequirementSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  requirement: z.string().min(1),
  status: z.enum(['pass', 'partial', 'fail']),
  evidence: z.string().optional(),
  notes: z.string().optional(),
});

export const specReviewDriftItemSchema = z.object({
  spec_symbol: z.string().min(1),
  actual_symbol: z.string().min(1),
  deviation_annotated: z.boolean(),
  files: z.array(z.string()).optional(),
});

export const specReviewFindingSchema = z.object({
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  summary: z.string().min(1),
  file: z.string().min(1).optional(),
  suggested_fix: z.string().min(1).optional(),
});

const specReviewLegacySchema = z.object({
  result: z.enum(['pass', 'fail']),
  verdict: z.undefined().optional(),
  findings: z.array(specReviewFindingSchema).optional().default([]),
  requirements: z.array(specReviewRequirementSchema).optional().default([]),
  drift_items: z.array(specReviewDriftItemSchema).optional().default([]),
});

const specReviewAnchoredSchema = z.object({
  verdict: z.enum(['pass', 'partial', 'fail']),
  result: z.undefined().optional(),
  findings: z.array(specReviewFindingSchema).optional().default([]),
  requirements: z.array(specReviewRequirementSchema).optional().default([]),
  drift_items: z.array(specReviewDriftItemSchema).optional().default([]),
});

export const specReviewResultSchema = z.union([specReviewAnchoredSchema, specReviewLegacySchema]);
export type SpecReviewResult = z.infer<typeof specReviewResultSchema>;
export type SpecReviewRequirement = z.infer<typeof specReviewRequirementSchema>;
export type SpecReviewDriftItem = z.infer<typeof specReviewDriftItemSchema>;

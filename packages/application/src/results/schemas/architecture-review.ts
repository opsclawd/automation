import { z } from 'zod';

export const architectureReviewFindingSchema = z.object({
  category: z
    .enum([
      'requirements_reconciliation',
      'contract_conservation',
      'invariant_completeness',
      'downstream_compatibility',
      'other',
    ])
    .optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'P0', 'P1', 'P2', 'P3']),
  target: z.string().optional(),
  evidence: z.string().min(1),
  rationale: z.string().min(1),
  minimal_correction: z.string().min(1),
  blocking: z.boolean().optional(),
});

export const requirementsCheckSchema = z.object({
  requirement: z.string().min(1),
  result: z.enum(['PASS', 'FAIL', 'pass', 'fail']),
  evidence: z.string().optional(),
});

export const architectureReviewResultSchema = z.object({
  verdict: z.enum([
    'APPROVE',
    'REQUEST_CHANGES',
    'approve',
    'request_changes',
    'PASS',
    'FAIL',
    'pass',
    'fail',
  ]),
  requirements_checks: z.array(requirementsCheckSchema).optional().default([]),
  findings: z.array(architectureReviewFindingSchema).optional().default([]),
  summary: z.string().optional(),
  review_md: z.string().optional(),
});

export type ArchitectureReviewFinding = z.infer<typeof architectureReviewFindingSchema>;
export type RequirementsCheck = z.infer<typeof requirementsCheckSchema>;
export type ArchitectureReviewResult = z.infer<typeof architectureReviewResultSchema>;

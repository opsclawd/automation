import { z } from 'zod';
import type { ArchitectureRequirementsLedger } from '../../phases/architecture-requirements.js';

export const architectureReviewFindingSchema = z.object({
  category: z
    .enum([
      'requirements_reconciliation',
      'contract_conservation',
      'invariant_completeness',
      'downstream_compatibility',
      'representational_completeness',
      'provenance_layering',
      'conditional_invariants',
      'witness_scenarios',
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
  requirement_id: z.string().optional(),
  requirement: z.string().min(1),
  result: z.enum(['PASS', 'FAIL', 'pass', 'fail']),
  evidence: z.string().optional(),
});

export const witnessScenarioSchema = z.object({
  scenario: z.string().min(1),
  result: z.enum(['PASS', 'FAIL', 'pass', 'fail']),
  evidence: z.string().min(1),
  counterexample: z.string().optional(),
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
  witness_scenarios: z.array(witnessScenarioSchema).optional().default([]),
  findings: z.array(architectureReviewFindingSchema).optional().default([]),
  summary: z.string().optional(),
  review_md: z.string().optional(),
});

export type ArchitectureReviewFinding = z.infer<typeof architectureReviewFindingSchema>;
export type RequirementsCheck = z.infer<typeof requirementsCheckSchema>;
export type WitnessScenario = z.infer<typeof witnessScenarioSchema>;
export type ArchitectureReviewResult = z.infer<typeof architectureReviewResultSchema>;

/**
 * Evaluates whether an architecture review result meets all criteria for approval:
 * 1. verdict is 'APPROVE' or 'PASS'
 * 2. requirements_checks is present, non-empty, and every check has result 'PASS'
 * 3. if a requirements ledger is provided, every ledger item must be dispositioned with 'PASS'
 * 4. if witness_scenarios are present, none have result 'FAIL'
 * 5. no blocking findings (blocking === true or severity in ['critical', 'high', 'P0', 'P1'])
 */
export function isApprovedArchitectureReview(
  review: ArchitectureReviewResult,
  ledger?: ArchitectureRequirementsLedger,
): boolean {
  const verdict = review.verdict?.toUpperCase();
  if (verdict !== 'APPROVE' && verdict !== 'PASS') {
    return false;
  }
  if (!review.requirements_checks || review.requirements_checks.length === 0) {
    return false;
  }
  const allReqsPass = review.requirements_checks.every((c) => c.result?.toUpperCase() === 'PASS');
  if (!allReqsPass) {
    return false;
  }

  // If a ledger is provided, every item in the ledger must be dispositioned by a PASS check
  if (ledger && ledger.items.length > 0) {
    const checks = review.requirements_checks;
    for (const item of ledger.items) {
      const match = checks.find(
        (c) =>
          (c.requirement_id &&
            c.requirement_id.toLowerCase().trim() === item.id.toLowerCase().trim()) ||
          c.requirement.trim().toLowerCase() === item.title.trim().toLowerCase() ||
          (item.description &&
            c.requirement.trim().toLowerCase() === item.description.trim().toLowerCase()) ||
          c.requirement.trim().toLowerCase().includes(item.id.toLowerCase().trim()),
      );
      if (!match || match.result?.toUpperCase() !== 'PASS') {
        return false;
      }
    }
  }

  // If any witness scenario failed, review is not approved
  if (review.witness_scenarios && review.witness_scenarios.length > 0) {
    const hasFailedWitness = review.witness_scenarios.some(
      (w) => w.result?.toUpperCase() === 'FAIL',
    );
    if (hasFailedWitness) {
      return false;
    }
  }

  const hasBlockingFindings = review.findings?.some((f) => {
    if (f.blocking === true) return true;
    if (['critical', 'high', 'P0', 'P1'].includes(f.severity)) return true;
    return false;
  });
  if (hasBlockingFindings) {
    return false;
  }
  return true;
}

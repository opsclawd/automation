import { z } from 'zod';
import type { ArchitectureRequirementsLedger } from '../../phases/requirements-ledger.js';

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
  requirement_ids: z.array(z.string()).optional(),
  requirement_id: z.string().optional(),
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
 * Detects whether evidence exhibits provenance layer conflation by treating
 * profile/configuration identity as proof of measured/executed stream metadata.
 */
export function hasProvenanceConflationEvidence(
  requirementText: string,
  evidenceText?: string,
): boolean {
  if (!evidenceText) return false;
  const isProvenanceRequirement =
    /provenance|measured|probe|stream\s+metadata|executed\s+and\s+measured|actual\s+output/i.test(
      requirementText,
    );
  if (!isProvenanceRequirement) return false;

  const conflatesProfileWithMeasured =
    /(?:assembly\s*profile|profile\s*id|versioned\s*profile|profile\s+identif|profile\s+version|profile\s+name).*(?:identif|proves|guarantees|specifies|sufficient|measures|substitut|verif)/i.test(
      evidenceText,
    );
  return conflatesProfileWithMeasured;
}

/**
 * Evaluates whether an architecture review result meets all criteria for approval:
 * 1. verdict is 'APPROVE' or 'PASS'
 * 2. requirements_checks is present, non-empty, and every check has result 'PASS'
 * 3. if a requirements ledger is provided:
 *    - every ledger ID must appear exactly once in requirements_checks
 *    - no duplicate ledger IDs
 *    - no omitted ledger IDs
 *    - exact requirement_id matching (no fuzzy fallback)
 * 4. if the ledger contains consumer requirements, witness_scenarios must be present, non-empty, and all PASS
 * 5. if witness_scenarios are present, none have result 'FAIL' and all have non-empty evidence
 * 6. no requirement check or witness scenario exhibits provenance layer conflation (e.g. profile ID as measured data)
 * 7. no blocking findings (blocking === true or severity in ['critical', 'high', 'P0', 'P1'])
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

  // Exact 1-to-1 ledger disposition gate
  if (ledger && ledger.items.length > 0) {
    const checks = review.requirements_checks;
    const seenLedgerIds = new Set<string>();

    for (const check of checks) {
      if (check.requirement_id) {
        const normId = check.requirement_id.toUpperCase().trim();
        const isLedgerItem = ledger.items.some((it) => it.id.toUpperCase().trim() === normId);
        if (isLedgerItem) {
          if (seenLedgerIds.has(normId)) {
            // Duplicate ledger ID fails approval
            return false;
          }
          seenLedgerIds.add(normId);
        }
      }
    }

    // Every ledger item ID must appear exactly once
    if (seenLedgerIds.size !== ledger.items.length) {
      return false;
    }

    // Mandatory and specific witness scenarios for consumer requirements
    const consumerItems = ledger.items.filter((it) => it.category === 'consumer_requirement');
    if (consumerItems.length > 0) {
      if (!review.witness_scenarios || review.witness_scenarios.length === 0) {
        return false;
      }

      // Collect all requirement IDs covered by passing witness scenarios
      const coveredRequirementIds = new Set<string>();
      for (const w of review.witness_scenarios) {
        if (w.result?.toUpperCase() === 'PASS') {
          if (w.requirement_ids) {
            for (const id of w.requirement_ids) {
              coveredRequirementIds.add(id.toUpperCase().trim());
            }
          }
          if (w.requirement_id) {
            coveredRequirementIds.add(w.requirement_id.toUpperCase().trim());
          }
        }
      }

      // Every consumer requirement item in the ledger must be covered by a passing witness scenario
      for (const consumerItem of consumerItems) {
        const itemId = consumerItem.id.toUpperCase().trim();
        if (!coveredRequirementIds.has(itemId)) {
          return false;
        }
      }
    }
  }

  // Validate witness scenarios if present
  if (review.witness_scenarios && review.witness_scenarios.length > 0) {
    const allWitnessesPass = review.witness_scenarios.every(
      (w) => w.result?.toUpperCase() === 'PASS' && w.evidence.trim().length > 0,
    );
    if (!allWitnessesPass) {
      return false;
    }
  }

  // Provenance layer conflation anti-trap check
  for (const check of review.requirements_checks) {
    if (hasProvenanceConflationEvidence(check.requirement, check.evidence)) {
      return false;
    }
  }
  if (review.witness_scenarios) {
    for (const witness of review.witness_scenarios) {
      if (hasProvenanceConflationEvidence(witness.scenario, witness.evidence)) {
        return false;
      }
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

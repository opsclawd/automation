import { z } from 'zod';
import { wholeChangeReviewFindingSchema } from './whole-change-review.js';
import type { RequirementsLedger } from '../../phases/requirements-ledger.js';

export const postImplementationRequirementCheckSchema = z.object({
  requirement_id: z.string().min(1),
  requirement: z.string().min(1),
  result: z.enum(['PASS', 'FAIL', 'pass', 'fail']),
  evidence: z.string().min(1),
  test_evidence: z.string().optional(),
  counterexample_considered: z.string().optional(),
});

export const postImplementationSpecReviewResultSchema = z.object({
  verdict: z.enum(['PASS', 'FAIL', 'pass', 'fail']),
  requirements_checks: z.array(postImplementationRequirementCheckSchema).default([]),
  findings: z.array(wholeChangeReviewFindingSchema).optional().default([]),
  summary: z.string().optional(),
  review_md: z.string().optional(),
});

export type PostImplementationRequirementCheck = z.infer<
  typeof postImplementationRequirementCheckSchema
>;
export type PostImplementationSpecReviewResult = z.infer<
  typeof postImplementationSpecReviewResultSchema
>;

/**
 * Evaluates whether a post-implementation spec review result meets all criteria for approval:
 * 1. verdict is 'PASS'
 * 2. requirements_checks is present, non-empty, and every check has result 'PASS'
 * 3. if a requirements ledger is provided:
 *    - every ledger ID must appear exactly once in requirements_checks
 *    - no duplicate ledger IDs
 *    - no omitted ledger IDs
 *    - every hard-gate ledger item MUST have a non-empty counterexample_considered
 * 4. no blocking findings (blocking === true or severity in ['critical', 'high', 'P0', 'P1'])
 */
export function isApprovedSpecReview(
  review: PostImplementationSpecReviewResult,
  ledger?: RequirementsLedger,
): boolean {
  const verdict = review.verdict?.toUpperCase();
  if (verdict !== 'PASS') {
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

    // Hard-gate adversarial counterexample verification
    for (const item of ledger.items) {
      if (item.hardGate) {
        const normId = item.id.toUpperCase().trim();
        const check = checks.find((c) => c.requirement_id.toUpperCase().trim() === normId);
        if (
          !check ||
          !check.counterexample_considered ||
          check.counterexample_considered.trim().length === 0
        ) {
          return false;
        }
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

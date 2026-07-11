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
  schemaContractText: string;
}

export function normalizePhaseId(phaseId: string): string {
  return phaseId.replace(/-\d+$/, '');
}

// Temporary mapping from CANONICAL_PHASE_ORDER names to PHASE_RESULT_REGISTRY keys.
// Phases with no result entry (null) do not produce result.json artifacts.
// TODO: converge PHASE_RESULT_REGISTRY into CANONICAL_PHASE_ORDER so there's one source of truth.
export const PHASE_NAME_MIGRATION_MAP: Record<string, string | null> = {
  'plan-design': null,
  'plan-write': null,
  'plan-review': null,
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
  implement: {
    schema: implementResultSchema,
    schemaContractText:
      '{\n  "result": "success" | "partial" | "failed",\n  "changedFiles": string[]\n}',
  },
  'quality-review': {
    schema: qualityReviewResultSchema,
    schemaContractText:
      '{\n  "result": "pass" | "fail",\n  "findings": Array<{\n    "severity": "P0" | "P1" | "P2" | "P3",\n    "summary": string,\n    "file"?: string,\n    "suggested_fix"?: string\n  }>\n}',
  },
  // Retained as loop-internal routing schemas for agent invocation dispatch
  // within the review-fix phase (see design decision in design-decisions-report.md).
  // These are NOT reachable via PHASE_NAME_MIGRATION_MAP for result.json production.
  'fix-review': {
    schema: fixReviewResultSchema,
    schemaContractText:
      '{\n  "result": "done_with_fixes" | "cannot_fix"\n} | {\n  "result": "done_no_fixes_needed",\n  "rebuttal": string\n}',
  },
  'create-pr': {
    schema: createPrResultSchema,
    schemaContractText: '{\n  "result": "created",\n  "prNumber": number,\n  "prUrl": string\n}',
  },
  'post-pr-review': {
    schema: postPrReviewResultSchema,
    schemaContractText:
      '{\n  "outcome": "ALL_DONE" | "NO_FIXES_NEEDED" | "PARTIAL" | "BLOCKED",\n  "comments": Array<{\n    "commentId": number,\n    "action": "fixed" | "no_fix" | "blocked",\n    "replyBody": string,\n    "blockedReason"?: string\n  }>\n}',
  },
  'spec-review': {
    schema: specReviewResultSchema,
    schemaContractText:
      '{\n  "result": "pass" | "fail",\n  "findings": Array<{\n    "severity": "P0" | "P1" | "P2" | "P3",\n    "summary": string,\n    "file"?: string,\n    "suggested_fix"?: string\n  }>\n}',
  },
  'whole-pr-review': {
    schema: wholePrReviewResultSchema,
    schemaContractText:
      '{\n  "result": "pass" | "fail",\n  "findings": Array<{\n    "severity": string,\n    "summary": string\n  }>\n}',
  },
  compound: {
    schema: compoundResultSchema,
    schemaContractText: '{\n  "result": "written",\n  "path": string,\n  "summary": string\n}',
  },
  'fix-validate': {
    schema: fixValidateResultSchema,
    schemaContractText: '{\n  "result": "fixed" | "cannot_fix"\n}',
  },
  arbiter: {
    schema: arbiterResultSchema,
    schemaContractText:
      '{\n  "outcome": "finding_invalid" | "finding_valid" | "ambiguous" | "insufficient_evidence",\n  "defect_classification"?: string,\n  "evidence": string,\n  "rationale": string\n}',
  },
  'plan-review-arbiter': {
    schema: arbiterResultSchema,
    schemaContractText:
      '{\n  "outcome": "finding_invalid" | "finding_valid" | "ambiguous" | "insufficient_evidence",\n  "defect_classification"?: string,\n  "evidence": string,\n  "rationale": string\n}',
  },
  'implement-final-review-arbiter': {
    schema: arbiterResultSchema,
    schemaContractText:
      '{\n  "outcome": "finding_invalid" | "finding_valid" | "ambiguous" | "insufficient_evidence",\n  "defect_classification"?: string,\n  "evidence": string,\n  "rationale": string\n}',
  },
};

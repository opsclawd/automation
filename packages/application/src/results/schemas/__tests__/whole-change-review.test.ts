import { describe, it, expect } from 'vitest';
import {
  wholeChangeReviewResultSchema,
  wholeChangeReviewFindingSchema,
  acceptanceCriterionCheckSchema,
} from '../whole-change-review.js';

describe('wholeChangeReviewResultSchema', () => {
  it('validates a valid APPROVE result with acceptance criteria and no findings', () => {
    const data = {
      verdict: 'APPROVE',
      acceptance_criteria: [
        {
          criterion: 'Single implementation pass completes successfully',
          result: 'PASS',
          evidence: 'Verified in commit history and logs',
        },
        {
          criterion: 'Deterministic validation passes',
          result: 'PASS',
        },
      ],
      findings: [],
      summary: 'All checks passed cleanly.',
    };

    const parsed = wholeChangeReviewResultSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.verdict).toBe('APPROVE');
      expect(parsed.data.acceptance_criteria).toHaveLength(2);
      expect(parsed.data.findings).toEqual([]);
    }
  });

  it('validates a valid REQUEST_CHANGES result with structured findings', () => {
    const data = {
      verdict: 'REQUEST_CHANGES',
      acceptance_criteria: [
        {
          criterion: 'Layer boundaries respected',
          result: 'FAIL',
          evidence: 'packages/application imports @ai-sdlc/infrastructure',
        },
      ],
      findings: [
        {
          severity: 'high',
          files: ['packages/application/src/ports.ts'],
          evidence: "import { SqliteRunRepository } from '@ai-sdlc/infrastructure'",
          rationale: 'Violates inward-only dependency rule for application layer',
          minimal_correction: 'Move import to composition root in apps/api/src/compose.ts',
          blocking: true,
        },
      ],
      summary: 'Layer boundary violation detected in ports.ts',
    };

    const parsed = wholeChangeReviewResultSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.verdict).toBe('REQUEST_CHANGES');
      expect(parsed.data.findings).toHaveLength(1);
      expect(parsed.data.findings[0]?.severity).toBe('high');
      expect(parsed.data.findings[0]?.blocking).toBe(true);
    }
  });

  it('accepts lowercase verdict and result variants', () => {
    const data = {
      verdict: 'approve',
      acceptance_criteria: [
        {
          criterion: 'Criterion 1',
          result: 'pass',
        },
      ],
    };

    const parsed = wholeChangeReviewResultSchema.safeParse(data);
    expect(parsed.success).toBe(true);
  });

  it('rejects invalid verdict values', () => {
    const data = {
      verdict: 'INVALID_VERDICT',
      acceptance_criteria: [],
    };

    const parsed = wholeChangeReviewResultSchema.safeParse(data);
    expect(parsed.success).toBe(false);
  });

  it('rejects findings missing required evidence, rationale, or minimal_correction', () => {
    const data = {
      severity: 'high',
      evidence: '',
      rationale: 'Missing evidence',
      minimal_correction: 'Provide evidence',
    };

    const parsed = wholeChangeReviewFindingSchema.safeParse(data);
    expect(parsed.success).toBe(false);
  });

  it('validates acceptanceCriterionCheckSchema directly', () => {
    const valid = { criterion: 'Criteria 1', result: 'PASS', evidence: 'Verified in logs' };
    expect(acceptanceCriterionCheckSchema.safeParse(valid).success).toBe(true);

    const invalid = { criterion: '', result: 'INVALID' };
    expect(acceptanceCriterionCheckSchema.safeParse(invalid).success).toBe(false);
  });
});

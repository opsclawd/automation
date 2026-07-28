import { describe, it, expect } from 'vitest';
import type { ArbiterResult } from '../../implement-step/types.js';
import type { PlanReviewArbiterResult } from '../types.js';
import { verifyPlanReviewArbiterGrounding } from '../arbiter-grounding.js';

function arbiterGroundingResult(
  result: ArbiterResult,
  groundingSources: PlanReviewArbiterResult['groundingSources'] = {
    planExcerpt: 'The defect is real and not addressed by prior fixes.',
    manifestExcerpt: '{"version":2}',
  },
): PlanReviewArbiterResult {
  return { ...result, groundingSources };
}

describe('verifyPlanReviewArbiterGrounding', () => {
  it('ignores grounding for outcomes other than finding_valid', () => {
    const outcomes: ArbiterResult['outcome'][] = [
      'finding_invalid',
      'ambiguous',
      'insufficient_evidence',
    ];
    for (const outcome of outcomes) {
      const result = arbiterGroundingResult({ outcome, evidence: '', rationale: '' });
      const check = verifyPlanReviewArbiterGrounding(result);
      expect(check.status).toBe('not_applicable');
      expect(check.quotes).toEqual([]);
      expect(check.unmatchedQuotes).toEqual([]);
    }
  });

  it('rejects finding_valid when no non-empty quote tags are present', () => {
    const result = arbiterGroundingResult({
      outcome: 'finding_valid',
      evidence: 'The defect is real.',
      rationale: 'No quote tags here.',
    });
    const check = verifyPlanReviewArbiterGrounding(result);
    expect(check.status).toBe('ungrounded');
    expect(check.reason).toBe('missing_quotes');
    expect(check.quotes).toEqual([]);
    expect(check.unmatchedQuotes).toEqual([]);
  });

  it('rejects finding_valid when any tagged quote is absent from both sources', () => {
    const result = arbiterGroundingResult({
      outcome: 'finding_valid',
      evidence: 'The defect is real and not addressed by prior fixes.',
      rationale: 'Cited text: <quote>this text is nowhere to be found</quote>',
    });
    const check = verifyPlanReviewArbiterGrounding(result);
    expect(check.status).toBe('ungrounded');
    expect(check.reason).toBe('unmatched_quotes');
    expect(check.quotes).toEqual(['this text is nowhere to be found']);
    expect(check.unmatchedQuotes).toEqual(['this text is nowhere to be found']);
  });

  it('accepts finding_valid when every quote matches plan or manifest after whitespace normalization', () => {
    const result = arbiterGroundingResult(
      {
        outcome: 'finding_valid',
        evidence: 'Quote from plan: <quote>The defect is real and not addressed</quote>',
        rationale: 'Quote from manifest: <quote>{"version":2}</quote>',
      },
      {
        planExcerpt: '  The  defect  is  real  and  not  addressed  ',
        manifestExcerpt: '{"version":2}',
      },
    );
    const check = verifyPlanReviewArbiterGrounding(result);
    expect(check.status).toBe('grounded');
    expect(check.quotes).toEqual(['The defect is real and not addressed', '{"version":2}']);
    expect(check.unmatchedQuotes).toEqual([]);
  });

  it('keeps quote matching case and punctuation sensitive', () => {
    const result = arbiterGroundingResult(
      {
        outcome: 'finding_valid',
        evidence: 'Quote: <quote>The Defect Is Real</quote>',
        rationale: '',
      },
      {
        planExcerpt: 'the defect is real',
        manifestExcerpt: '',
      },
    );
    const check = verifyPlanReviewArbiterGrounding(result);
    expect(check.status).toBe('ungrounded');
    expect(check.reason).toBe('unmatched_quotes');
    expect(check.unmatchedQuotes).toEqual(['The Defect Is Real']);
  });

  it('handles quotes spanning line and tab whitespace differences', () => {
    const result = arbiterGroundingResult(
      {
        outcome: 'finding_valid',
        evidence: '<quote>line one\n\tline two</quote>',
        rationale: '',
      },
      {
        planExcerpt: 'line one    line two',
        manifestExcerpt: '',
      },
    );
    const check = verifyPlanReviewArbiterGrounding(result);
    expect(check.status).toBe('grounded');
    expect(check.quotes).toEqual(['line one line two']);
    expect(check.unmatchedQuotes).toEqual([]);
  });

  it('rejects malformed or unclosed quote tags', () => {
    const result = arbiterGroundingResult({
      outcome: 'finding_valid',
      evidence: '<quote>closed</quote> and <quote>unclosed',
      rationale: '',
    });
    const check = verifyPlanReviewArbiterGrounding(result);
    expect(check.status).toBe('ungrounded');
    expect(check.reason).toBe('unmatched_quotes');
    expect(check.quotes).toEqual(['closed']);
    expect(check.unmatchedQuotes).toEqual(['closed']);
  });

  it('rejects empty normalized tag bodies', () => {
    const result = arbiterGroundingResult({
      outcome: 'finding_valid',
      evidence: '<quote>   </quote>',
      rationale: '',
    });
    const check = verifyPlanReviewArbiterGrounding(result);
    expect(check.status).toBe('ungrounded');
    expect(check.reason).toBe('missing_quotes');
  });

  it('reports only unmatched normalized quotes when some match and some do not', () => {
    const result = arbiterGroundingResult(
      {
        outcome: 'finding_valid',
        evidence: '<quote>The defect is real</quote>',
        rationale: '<quote>nowhere to be found</quote>',
      },
      {
        planExcerpt: 'The defect is real',
        manifestExcerpt: '',
      },
    );
    const check = verifyPlanReviewArbiterGrounding(result);
    expect(check.status).toBe('ungrounded');
    expect(check.reason).toBe('unmatched_quotes');
    expect(check.quotes).toEqual(['The defect is real', 'nowhere to be found']);
    expect(check.unmatchedQuotes).toEqual(['nowhere to be found']);
  });

  it('extracts quotes from both evidence and rationale', () => {
    const result = arbiterGroundingResult(
      {
        outcome: 'finding_valid',
        evidence: '<quote>from evidence</quote>',
        rationale: '<quote>from rationale</quote>',
      },
      {
        planExcerpt: 'from evidence and from rationale',
        manifestExcerpt: '',
      },
    );
    const check = verifyPlanReviewArbiterGrounding(result);
    expect(check.status).toBe('grounded');
    expect(check.quotes).toEqual(['from evidence', 'from rationale']);
    expect(check.unmatchedQuotes).toEqual([]);
  });

  it('splits quotes between plan and manifest', () => {
    const result = arbiterGroundingResult(
      {
        outcome: 'finding_valid',
        evidence: '<quote>found in plan only</quote>',
        rationale: '<quote>found in manifest only</quote>',
      },
      {
        planExcerpt: 'found in plan only',
        manifestExcerpt: 'found in manifest only',
      },
    );
    const check = verifyPlanReviewArbiterGrounding(result);
    expect(check.status).toBe('grounded');
    expect(check.quotes).toEqual(['found in plan only', 'found in manifest only']);
    expect(check.unmatchedQuotes).toEqual([]);
  });
});

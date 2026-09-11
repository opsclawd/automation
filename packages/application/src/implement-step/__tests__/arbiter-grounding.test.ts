import { describe, it, expect } from 'vitest';
import type { ArbiterResult } from '../types.js';
import { verifyArbiterGrounding } from '../arbiter-grounding.js';

describe('verifyArbiterGrounding', () => {
  it('ignores grounding for outcomes other than finding_valid', () => {
    const outcomes: ArbiterResult['outcome'][] = [
      'finding_invalid',
      'ambiguous',
      'insufficient_evidence',
    ];
    for (const outcome of outcomes) {
      const result = { outcome, evidence: '', rationale: '' };
      const check = verifyArbiterGrounding(result, ['plan text']);
      expect(check.status).toBe('not_applicable');
      expect(check.quotes).toEqual([]);
      expect(check.unmatchedQuotes).toEqual([]);
    }
  });

  it('rejects finding_valid when no non-empty quote tags are present', () => {
    const result = {
      outcome: 'finding_valid',
      evidence: 'The defect is real.',
      rationale: 'No quote tags here.',
    };
    const check = verifyArbiterGrounding(result, ['The defect is real.']);
    expect(check.status).toBe('ungrounded');
    expect(check.reason).toBe('missing_quotes');
    expect(check.quotes).toEqual([]);
    expect(check.unmatchedQuotes).toEqual([]);
  });

  it('rejects finding_valid when any tagged quote is absent from sources', () => {
    const result = {
      outcome: 'finding_valid',
      evidence: 'The defect is real and not addressed by prior fixes.',
      rationale: 'Cited text: <quote>this text is nowhere to be found</quote>',
    };
    const check = verifyArbiterGrounding(result, ['some plan content']);
    expect(check.status).toBe('ungrounded');
    expect(check.reason).toBe('unmatched_quotes');
    expect(check.quotes).toEqual(['this text is nowhere to be found']);
    expect(check.unmatchedQuotes).toEqual(['this text is nowhere to be found']);
  });

  it('accepts finding_valid when every quote matches a source after whitespace normalization', () => {
    const result = {
      outcome: 'finding_valid',
      evidence: 'Quote from plan: <quote>The defect is real and not addressed</quote>',
      rationale: 'Quote from manifest: <quote>{"version":2}</quote>',
    };
    const sources = ['  The  defect  is  real  and  not  addressed  ', '{"version":2}'];
    const check = verifyArbiterGrounding(result, sources);
    expect(check.status).toBe('grounded');
    expect(check.quotes).toEqual(['The defect is real and not addressed', '{"version":2}']);
    expect(check.unmatchedQuotes).toEqual([]);
  });
});

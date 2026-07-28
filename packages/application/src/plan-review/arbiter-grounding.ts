import type { PlanReviewArbiterResult } from './types.js';

export type ArbiterGroundingStatus = 'not_applicable' | 'grounded' | 'ungrounded';
export type ArbiterGroundingFailureReason = 'missing_quotes' | 'unmatched_quotes';

export interface ArbiterGroundingCheck {
  status: ArbiterGroundingStatus;
  reason?: ArbiterGroundingFailureReason;
  quotes: string[];
  unmatchedQuotes: string[];
}

const QUOTE_PATTERN = /<quote>([\s\S]*?)<\/quote>/g;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function extractRawQuotes(value: string): string[] {
  return Array.from(value.matchAll(QUOTE_PATTERN), (match) =>
    normalizeWhitespace(match[1] ?? ''),
  ).filter((q) => q.length > 0);
}

export function verifyPlanReviewArbiterGrounding(
  result: PlanReviewArbiterResult,
): ArbiterGroundingCheck {
  if (result.outcome !== 'finding_valid') {
    return { status: 'not_applicable', quotes: [], unmatchedQuotes: [] };
  }

  const quotes = extractRawQuotes(`${result.evidence}\n${result.rationale}`);
  if (quotes.length === 0) {
    return {
      status: 'ungrounded',
      reason: 'missing_quotes',
      quotes: [],
      unmatchedQuotes: [],
    };
  }

  const sources = [
    normalizeWhitespace(result.groundingSources.planExcerpt),
    normalizeWhitespace(result.groundingSources.manifestExcerpt),
  ];
  const unmatchedQuotes = quotes.filter(
    (quote) => !sources.some((source) => source.includes(quote)),
  );

  return unmatchedQuotes.length === 0
    ? { status: 'grounded', quotes, unmatchedQuotes: [] }
    : {
        status: 'ungrounded',
        reason: 'unmatched_quotes',
        quotes,
        unmatchedQuotes,
      };
}

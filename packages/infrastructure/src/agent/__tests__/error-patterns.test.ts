import { describe, it, expect } from 'vitest';
import {
  isOpenCodeLogLine,
  testQuotaPatterns,
  testProviderErrorPatterns,
  testTokenLimitPatterns,
  getLastLines,
} from '../error-patterns.js';

describe('isOpenCodeLogLine', () => {
  it('accepts valid INFO log line', () => {
    expect(isOpenCodeLogLine('INFO  2026-05-28T22:51:15.000Z +0ms service=llm msg=ok')).toBe(true);
  });

  it('accepts valid ERROR log line', () => {
    expect(isOpenCodeLogLine('ERROR 2026-05-28T22:51:15.000Z +0ms service=llm error=fail')).toBe(
      true,
    );
  });

  it('accepts valid WARN log line', () => {
    expect(isOpenCodeLogLine('WARN  2026-05-28T22:51:15.000Z +0ms service=llm warn=slow')).toBe(
      true,
    );
  });

  it('accepts valid DEBUG log line', () => {
    expect(isOpenCodeLogLine('DEBUG 2026-05-28T22:51:15.000Z +0ms service=llm debug=trace')).toBe(
      true,
    );
  });

  it('accepts line with leading whitespace', () => {
    expect(isOpenCodeLogLine('  INFO  2026-05-28T22:51:15.000Z +0ms service=llm')).toBe(true);
  });

  it('rejects plain text', () => {
    expect(isOpenCodeLogLine('just some random text')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isOpenCodeLogLine('')).toBe(false);
  });

  it('rejects code snippet with quota-like strings', () => {
    expect(
      isOpenCodeLogLine(
        "REVIEWER_PROVIDER_ERROR_PATTERNS='AI_APICallError|RESOURCE_EXHAUSTED|429|quota.*exceed'",
      ),
    ).toBe(false);
  });

  it('rejects raw JSON', () => {
    expect(
      isOpenCodeLogLine('{"name":"AI_APICallError","url":"https://example.com","statusCode":500}'),
    ).toBe(false);
  });

  it('rejects line with log level but no timestamp', () => {
    expect(isOpenCodeLogLine('ERROR something went wrong')).toBe(false);
  });
});

describe('testQuotaPatterns', () => {
  it('matches quota error in structural log line (default mode)', () => {
    const result = testQuotaPatterns(
      'INFO  2026-05-28T22:51:15.000Z +0ms service=llm Usage limit reached for 5 hour',
    );
    expect(result).toBeTruthy();
    expect(result).toContain('Usage limit reached');
  });

  it('does not match quota regex pattern string in env-var assignment (default mode)', () => {
    const result = testQuotaPatterns(
      "SOME_OTHER_VAR='AI_APICallError|RESOURCE_EXHAUSTED|quota.*exceed'",
    );
    expect(result).toBeNull();
  });

  it('matches 429 in unstructured bash variable assignment (default mode)', () => {
    const result = testQuotaPatterns(
      'QUOTA_EXCEEDED: RESOURCE_EXHAUSTED, statusCode 429, quota exceeded), retry up to 2 times with',
    );
    expect(result).toBeTruthy();
  });

  it('matches when structural line is mixed with non-structural lines (default mode)', () => {
    const text = [
      'some code output',
      'INFO  2026-05-28T22:51:15.000Z +0ms service=llm Usage limit reached',
      'more code output',
    ].join('\n');
    const result = testQuotaPatterns(text);
    expect(result).toBeTruthy();
    expect(result).toContain('Usage limit reached');
  });

  it('matches "statusCode": 429 in structural line (default mode)', () => {
    const result = testQuotaPatterns(
      'ERROR 2026-05-28T23:00:02.000Z +0ms service=llm "statusCode": 429 Too Many Requests',
    );
    expect(result).toBeTruthy();
  });

  it('matches 429 with HTTP prefix (default mode)', () => {
    const result = testQuotaPatterns('HTTP 429 Too Many Requests');
    expect(result).toBeTruthy();
    expect(result).toContain('HTTP 429');
  });

  it('matches 429 with statusCode prefix (default mode)', () => {
    const result = testQuotaPatterns('"statusCode": 429 rate limit exceeded');
    expect(result).toBeTruthy();
  });

  it('does not match bare 429 in arbitrary text (default mode)', () => {
    const result = testQuotaPatterns('fix: scope 429 error pattern to HTTP contexts (#245)');
    expect(result).toBeNull();
  });

  it('does not match bare 429 in git log output (default mode)', () => {
    const result = testQuotaPatterns(
      'de9307c feat: add manifest-validation helper functions (#240)',
    );
    expect(result).toBeNull();
  });

  it('matches rate_limit_exceeded independently of HTTP status code', () => {
    const result = testQuotaPatterns('error: rate_limit_exceeded for user');
    expect(result).toBeTruthy();
    expect(result).toContain('rate_limit_exceeded');
  });

  it('returns null when no patterns match (default mode)', () => {
    expect(testQuotaPatterns('just some text without any quota or provider patterns')).toBeNull();
  });

  it('matches quota error in structural log line (structuralOnly: true)', () => {
    const result = testQuotaPatterns(
      'INFO  2026-05-28T22:51:15.000Z +0ms service=llm Usage limit reached for 5 hour',
      { structuralOnly: true },
    );
    expect(result).toBeTruthy();
  });

  it('matches "Not Enough Credits" in structural log line (default mode)', () => {
    const result = testQuotaPatterns(
      'ERROR 2026-06-03T12:00:00.000Z +0ms service=llm {"error":{"code":401,"message":"Not Enough Credits","type":"unauthorized"}}',
    );
    expect(result).toBeTruthy();
    expect(result).toContain('Not Enough Credits');
  });
  it('matches "Not Enough Credits" in structural log line (structuralOnly: true)', () => {
    const result = testQuotaPatterns(
      'ERROR 2026-06-03T12:00:00.000Z +0ms service=llm {"error":{"code":401,"message":"Not Enough Credits","type":"unauthorized"}}',
      { structuralOnly: true },
    );
    expect(result).toBeTruthy();
    expect(result).toContain('Not Enough Credits');
  });
  it('matches Codex "ERROR: Quota exceeded" format (non-structural)', () => {
    const result = testQuotaPatterns('ERROR: Quota exceeded. Check your plan and billing details.');
    expect(result).toBeTruthy();
    expect(result).toContain('Quota exceeded');
  });

  it('matches underscore-delimited quota_exceeded', () => {
    expect(testQuotaPatterns('quota_exceeded')).toBeTruthy();
  });

  it('matches underscore-delimited quota_exceeded in a reference table row', () => {
    const tableRow = '| quota_exceeded | The request quota was exhausted | Retry after reset |';
    expect(testQuotaPatterns(tableRow)).toBeTruthy();
  });

  it('still matches "Quota exceeded" natural-language form', () => {
    const result = testQuotaPatterns('ERROR: Quota exceeded for this billing period.');
    expect(result).toBeTruthy();
    expect(result).toContain('Quota exceeded');
  });

  it('still matches "quota exceeded" natural-language form (lowercase)', () => {
    expect(testQuotaPatterns('quota exceeded for user')).toBeTruthy();
  });

  it('ignores quota pattern in non-structural line (structuralOnly: true)', () => {
    const result = testQuotaPatterns(
      "SOME_OTHER_VAR='AI_APICallError|RESOURCE_EXHAUSTED|429|quota.*exceed'",
      { structuralOnly: true },
    );
    expect(result).toBeNull();
  });

  it('ignores 429 in non-structural bash variable assignment (structuralOnly: true)', () => {
    const result = testQuotaPatterns(
      'QUOTA_EXCEEDED: RESOURCE_EXHAUSTED, 429, quota exceeded), retry up to 2 times with',
      { structuralOnly: true },
    );
    expect(result).toBeNull();
  });

  it('returns null when no structural lines match (structuralOnly: true)', () => {
    const text = [
      'random text with 429 in it',
      'code: quota exceeded handling',
      'some bash variable',
    ].join('\n');
    expect(testQuotaPatterns(text, { structuralOnly: true })).toBeNull();
  });

  it('respects maxLines: stops scanning before the matching line', () => {
    const text = ['Quota exceeded: API limit', 'line 2 harmless', 'line 3 harmless'].join('\n');
    // maxLines: 2 — only the last 2 lines are scanned; "Quota exceeded" is on line 1 (skipped)
    expect(testQuotaPatterns(text, { maxLines: 2 })).toBeNull();
  });

  it('respects maxLines: includes matching line when within limit', () => {
    const text = ['line 1 harmless', 'line 2 harmless', 'Quota exceeded: API limit'].join('\n');
    // maxLines: 2 — last 2 lines are scanned; "Quota exceeded" is on line 3 (in scope)
    const result = testQuotaPatterns(text, { maxLines: 2 });
    expect(result).toBeTruthy();
    expect(result).toContain('Quota exceeded');
  });

  it('handles non-positive maxLines correctly (does not match)', () => {
    const text = ['Quota exceeded: API limit'].join('\n');
    expect(testQuotaPatterns(text, { maxLines: 0 })).toBeNull();
    expect(testQuotaPatterns(text, { maxLines: -5 })).toBeNull();
  });

  it('matches quota errors with underscores and rate limit prefixes', () => {
    expect(testQuotaPatterns('quota_rate_exceeded')).toBeTruthy();
    expect(testQuotaPatterns('quota_limit_exceeded')).toBeTruthy();
    expect(testQuotaPatterns('quota-rate-exceed')).toBeTruthy();
    expect(testQuotaPatterns('quota_exceed')).toBeTruthy();
    expect(testQuotaPatterns('token_rate_limit_exceeded')).toBeTruthy();
    expect(testQuotaPatterns('tokens_rate_limit_exceeded')).toBeTruthy();
    expect(testQuotaPatterns('tokens rate limit exceeded')).toBeTruthy();
  });

  it('matches quota errors containing common punctuation', () => {
    expect(testQuotaPatterns('Quota: exceeded')).toBeTruthy();
    expect(testQuotaPatterns('quota (exceeded)')).toBeTruthy();
    expect(testQuotaPatterns('quota.exceeded')).toBeTruthy();
    expect(testQuotaPatterns('quota, exceeded')).toBeTruthy();
  });
});

describe('testProviderErrorPatterns', () => {
  it('matches provider error in structural log line (default mode)', () => {
    const result = testProviderErrorPatterns(
      'ERROR 2026-05-28T22:51:15.000Z +0ms service=llm {"name":"AI_APICallError","url":"https://example.com","statusCode":500}',
    );
    expect(result).toBeTruthy();
    expect(result).toContain('AI_APICallError');
  });

  it('matches provider error in raw JSON without structural prefix (default mode)', () => {
    const result = testProviderErrorPatterns(
      '{"name":"AI_APICallError","url":"https://example.com","statusCode":500}',
    );
    expect(result).toBeTruthy();
  });

  it('matches provider error in non-structural line (default mode)', () => {
    const result = testProviderErrorPatterns(
      "SOME_OTHER_VAR='AI_APICallError|RESOURCE_EXHAUSTED|429|quota.*exceed'",
    );
    expect(result).toBeTruthy();
  });

  it('matches RESOURCE_EXHAUSTED in non-structural line (default mode)', () => {
    const result = testProviderErrorPatterns(
      'QUOTA_EXCEEDED: RESOURCE_EXHAUSTED, 429, quota exceeded), retry up to 2 times with',
    );
    expect(result).toBeTruthy();
  });

  it('matches when structural line is mixed with non-structural lines (default mode)', () => {
    const text = [
      'code with no patterns here',
      'ERROR 2026-05-28T22:51:15.000Z +0ms service=llm ProviderError: API failure',
      'more code',
    ].join('\n');
    const result = testProviderErrorPatterns(text);
    expect(result).toBeTruthy();
    expect(result).toContain('ProviderError');
  });

  it('matches 500 with HTTP prefix (default mode)', () => {
    const result = testProviderErrorPatterns('HTTP 500 Internal Server Error');
    expect(result).toBeTruthy();
    expect(result).toContain('HTTP 500');
  });

  it('matches 503 with status prefix (default mode)', () => {
    const result = testProviderErrorPatterns('status 503 service unavailable error');
    expect(result).toBeTruthy();
  });

  it('does not match bare 500 in arbitrary text (default mode)', () => {
    const result = testProviderErrorPatterns('line 500 of the file has an error');
    expect(result).toBeNull();
  });

  it('does not match bare 503 in commit title (default mode)', () => {
    const result = testProviderErrorPatterns('fix: handle 503 error in retry logic');
    expect(result).toBeNull();
  });

  it('matches AI_APICallError independently of HTTP status code', () => {
    const result = testProviderErrorPatterns('AI_APICallError: something went wrong');
    expect(result).toBeTruthy();
    expect(result).toContain('AI_APICallError');
  });

  it('matches RESOURCE_EXHAUSTED independently of HTTP status code', () => {
    const result = testProviderErrorPatterns('RESOURCE_EXHAUSTED: limit reached');
    expect(result).toBeTruthy();
    expect(result).toContain('RESOURCE_EXHAUSTED');
  });

  it('returns null when no patterns match (default mode)', () => {
    expect(
      testProviderErrorPatterns('just some text without any quota or provider patterns'),
    ).toBeNull();
  });

  it('matches provider error in structural log line (structuralOnly: true)', () => {
    const result = testProviderErrorPatterns(
      'ERROR 2026-05-28T22:51:15.000Z +0ms service=llm {"name":"AI_APICallError","url":"https://example.com","statusCode":500}',
      { structuralOnly: true },
    );
    expect(result).toBeTruthy();
  });

  it('ignores provider error in non-structural line (structuralOnly: true)', () => {
    const result = testProviderErrorPatterns(
      "SOME_OTHER_VAR='AI_APICallError|RESOURCE_EXHAUSTED|429|quota.*exceed'",
      { structuralOnly: true },
    );
    expect(result).toBeNull();
  });

  it('ignores raw JSON without structural prefix (structuralOnly: true)', () => {
    const result = testProviderErrorPatterns(
      '{"name":"AI_APICallError","url":"https://example.com","statusCode":500}',
      { structuralOnly: true },
    );
    expect(result).toBeNull();
  });

  it('ignores RESOURCE_EXHAUSTED in non-structural line (structuralOnly: true)', () => {
    const result = testProviderErrorPatterns(
      'QUOTA_EXCEEDED: RESOURCE_EXHAUSTED, 429, quota exceeded), retry up to 2 times with',
      { structuralOnly: true },
    );
    expect(result).toBeNull();
  });

  it('respects maxLines: stops scanning before the matching line', () => {
    const text = ['AI_APICallError: 500', 'line 2 harmless', 'line 3 harmless'].join('\n');
    // maxLines: 2 — only the last 2 lines are scanned; AI_APICallError is on line 1
    expect(testProviderErrorPatterns(text, { maxLines: 2 })).toBeNull();
  });

  it('respects maxLines: includes matching line when within limit', () => {
    const text = ['line 1 harmless', 'line 2 harmless', 'AI_APICallError: 500'].join('\n');
    const result = testProviderErrorPatterns(text, { maxLines: 2 });
    expect(result).toBeTruthy();
    expect(result).toContain('AI_APICallError');
  });

  it('matches various natural language forms of quota errors', () => {
    expect(testQuotaPatterns('Quota limit exceeded')).toBeTruthy();
    expect(testQuotaPatterns('Quota has been exceeded')).toBeTruthy();
    expect(testQuotaPatterns('Quota is exceeded')).toBeTruthy();
  });

  it('ignores environment variable dumps or bash tracing in testQuotaPatterns', () => {
    expect(testQuotaPatterns("export REVIEWER_PROVIDER_ERROR_PATTERNS='quota.*exceed'")).toBeNull();
    expect(testQuotaPatterns("export SOME_PATTERNS='Quota limit exceeded'")).toBeNull();
    expect(testQuotaPatterns('+ Quota limit exceeded')).toBeNull();
    expect(testQuotaPatterns('++ Quota limit exceeded')).toBeNull();
  });

  it('ignores environment variable dumps or bash tracing in testProviderErrorPatterns', () => {
    expect(
      testProviderErrorPatterns("export REVIEWER_PROVIDER_ERROR_PATTERNS='AI_APICallError'"),
    ).toBeNull();
    expect(testProviderErrorPatterns("export SOME_PATTERNS='AI_APICallError'")).toBeNull();
    expect(testProviderErrorPatterns('+ AI_APICallError')).toBeNull();
    expect(testProviderErrorPatterns('++ AI_APICallError')).toBeNull();
  });
});

describe('testTokenLimitPatterns', () => {
  it('matches context length exceeded', () => {
    expect(testTokenLimitPatterns('context_length_exceeded')).toBeTruthy();
  });

  it('matches prompt is too long', () => {
    expect(testTokenLimitPatterns('prompt is too long')).toBeTruthy();
  });

  it('matches token limits with underscores, dashes, spaces, and rate limit prefixes', () => {
    expect(testTokenLimitPatterns('token_rate_limit_exceeded')).toBeNull();
    expect(testTokenLimitPatterns('tokens_rate_limit_exceeded')).toBeNull();
    expect(testTokenLimitPatterns('token_limit_exceeded')).toBeTruthy();
    expect(testTokenLimitPatterns('token-limit-exceeded')).toBeTruthy();
    expect(testTokenLimitPatterns('tokens rate limit exceeded')).toBeNull();
    expect(testTokenLimitPatterns('tokens_limit_exceed')).toBeTruthy();
  });

  it('matches maximum context length', () => {
    expect(testTokenLimitPatterns('maximum context length')).toBeTruthy();
  });

  it('matches request too large', () => {
    expect(testTokenLimitPatterns('request too large')).toBeTruthy();
  });

  it('ignores environment variable dumps or bash tracing in testTokenLimitPatterns', () => {
    expect(testTokenLimitPatterns("export SOME_PATTERNS='token_limit_exceeded'")).toBeNull();
    expect(testTokenLimitPatterns('+ token_limit_exceeded')).toBeNull();
    expect(testTokenLimitPatterns('++ token_limit_exceeded')).toBeNull();
  });

  it('ignores indented bash tracing lines', () => {
    expect(testProviderErrorPatterns('  + AI_APICallError')).toBeNull();
    expect(testProviderErrorPatterns('\t++ AI_APICallError')).toBeNull();
    expect(testQuotaPatterns('  + Quota limit exceeded')).toBeNull();
    expect(testQuotaPatterns('\t++ Quota limit exceeded')).toBeNull();
    expect(testTokenLimitPatterns('  + token_limit_exceeded')).toBeNull();
    expect(testTokenLimitPatterns('\t++ token_limit_exceeded')).toBeNull();
  });

  it('handles trailing newline correctly without losing the last non-empty line', () => {
    const text = 'harmless line 1\nAI_APICallError: 500\n';
    const result = testProviderErrorPatterns(text, { maxLines: 1 });
    expect(result).toBeTruthy();
    expect(result).toContain('AI_APICallError');
  });

  it('scans correct line range when maxLines is larger and trailing newline is present', () => {
    const text = 'AI_APICallError: 500\nharmless line 1\nharmless line 2\n';
    expect(testProviderErrorPatterns(text, { maxLines: 2 })).toBeNull();
    expect(testProviderErrorPatterns(text, { maxLines: 3 })).toBeTruthy();
  });

  it('matches token limit errors containing common punctuation', () => {
    expect(testTokenLimitPatterns('token limit: exceeded')).toBeTruthy();
    expect(testTokenLimitPatterns('tokens (limit exceeded)')).toBeTruthy();
    expect(testTokenLimitPatterns('tokens.limit.exceeded')).toBeTruthy();
    expect(testTokenLimitPatterns('token-limit, exceeded')).toBeTruthy();
  });
});

describe('getLastLines', () => {
  it('returns clean lines list with or without trailing newline when maxLines is undefined', () => {
    const text1 = 'line 1\nline 2\n';
    const text2 = 'line 1\nline 2';
    expect(getLastLines(text1)).toEqual(['line 1', 'line 2']);
    expect(getLastLines(text2)).toEqual(['line 1', 'line 2']);
  });

  it('returns clean lines list with or without trailing newline when maxLines is defined', () => {
    const text1 = 'line 1\nline 2\n';
    const text2 = 'line 1\nline 2';
    expect(getLastLines(text1, 1)).toEqual(['line 2']);
    expect(getLastLines(text2, 1)).toEqual(['line 2']);
    expect(getLastLines(text1, 2)).toEqual(['line 1', 'line 2']);
    expect(getLastLines(text2, 2)).toEqual(['line 1', 'line 2']);
  });
});

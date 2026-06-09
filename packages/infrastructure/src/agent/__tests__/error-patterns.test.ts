import { describe, it, expect } from 'vitest';
import {
  isOpenCodeLogLine,
  testQuotaPatterns,
  testProviderErrorPatterns,
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

  it('matches quota pattern in unstructured text (default mode)', () => {
    const result = testQuotaPatterns(
      "REVIEWER_PROVIDER_ERROR_PATTERNS='AI_APICallError|RESOURCE_EXHAUSTED|HTTP 429|quota.*exceed'",
    );
    expect(result).toBeTruthy();
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

  it('ignores quota pattern in non-structural line (structuralOnly: true)', () => {
    const result = testQuotaPatterns(
      "REVIEWER_PROVIDER_ERROR_PATTERNS='AI_APICallError|RESOURCE_EXHAUSTED|429|quota.*exceed'",
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
      "REVIEWER_PROVIDER_ERROR_PATTERNS='AI_APICallError|RESOURCE_EXHAUSTED|429|quota.*exceed'",
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
      "REVIEWER_PROVIDER_ERROR_PATTERNS='AI_APICallError|RESOURCE_EXHAUSTED|429|quota.*exceed'",
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
});

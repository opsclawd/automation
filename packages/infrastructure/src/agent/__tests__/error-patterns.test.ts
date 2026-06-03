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

describe('testQuotaPatterns with structural filtering', () => {
  it('matches quota error in structural log line', () => {
    const result = testQuotaPatterns(
      'INFO  2026-05-28T22:51:15.000Z +0ms service=llm Usage limit reached for 5 hour',
    );
    expect(result).toBeTruthy();
    expect(result).toContain('Usage limit reached');
  });

  it('ignores quota pattern in non-structural line', () => {
    const result = testQuotaPatterns(
      "REVIEWER_PROVIDER_ERROR_PATTERNS='AI_APICallError|RESOURCE_EXHAUSTED|429|quota.*exceed'",
    );
    expect(result).toBeNull();
  });

  it('matches when structural line is mixed with non-structural lines', () => {
    const text = [
      'some code output with 429 in it',
      'INFO  2026-05-28T22:51:15.000Z +0ms service=llm Usage limit reached',
      'more code output',
    ].join('\n');
    const result = testQuotaPatterns(text);
    expect(result).toBeTruthy();
    expect(result).toContain('Usage limit reached');
  });

  it('returns null when no structural lines match', () => {
    const text = [
      'random text with 429 in it',
      'code: quota exceeded handling',
      'some bash variable',
    ].join('\n');
    expect(testQuotaPatterns(text)).toBeNull();
  });

  it('matches "statusCode": 429 in structural line', () => {
    const result = testQuotaPatterns(
      'ERROR 2026-05-28T23:00:02.000Z +0ms service=llm "statusCode": 429 Too Many Requests',
    );
    expect(result).toBeTruthy();
  });

  it('ignores 429 in non-structural bash variable assignment', () => {
    const result = testQuotaPatterns(
      'QUOTA_EXCEEDED: RESOURCE_EXHAUSTED, 429, quota exceeded), retry up to 2 times with',
    );
    expect(result).toBeNull();
  });
});

describe('testProviderErrorPatterns with structural filtering', () => {
  it('matches provider error in structural log line', () => {
    const result = testProviderErrorPatterns(
      'ERROR 2026-05-28T22:51:15.000Z +0ms service=llm {"name":"AI_APICallError","url":"https://example.com","statusCode":500}',
    );
    expect(result).toBeTruthy();
    expect(result).toContain('AI_APICallError');
  });

  it('ignores provider error in non-structural line', () => {
    const result = testProviderErrorPatterns(
      "REVIEWER_PROVIDER_ERROR_PATTERNS='AI_APICallError|RESOURCE_EXHAUSTED|429|quota.*exceed'",
    );
    expect(result).toBeNull();
  });

  it('ignores raw JSON without structural prefix', () => {
    const result = testProviderErrorPatterns(
      '{"name":"AI_APICallError","url":"https://example.com","statusCode":500}',
    );
    expect(result).toBeNull();
  });

  it('matches when structural line is mixed with non-structural lines', () => {
    const text = [
      'code with AI_APICallError in a comment',
      'ERROR 2026-05-28T22:51:15.000Z +0ms service=llm ProviderError: API failure',
      'more code',
    ].join('\n');
    const result = testProviderErrorPatterns(text);
    expect(result).toBeTruthy();
    expect(result).toContain('ProviderError');
  });

  it('ignores RESOURCE_EXHAUSTED in non-structural line', () => {
    const result = testProviderErrorPatterns(
      'QUOTA_EXCEEDED: RESOURCE_EXHAUSTED, 429, quota exceeded), retry up to 2 times with',
    );
    expect(result).toBeNull();
  });
});

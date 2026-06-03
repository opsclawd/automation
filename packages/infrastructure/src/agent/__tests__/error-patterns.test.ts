import { describe, it, expect } from 'vitest';
import { isOpenCodeLogLine } from '../error-patterns.js';

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

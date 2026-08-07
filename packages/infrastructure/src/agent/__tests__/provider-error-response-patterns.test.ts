import { describe, it, expect } from 'vitest';
import { testProviderErrorPatterns, testQuotaPatterns } from '../error-patterns.js';

describe('provider error response patterns', () => {
  it('matches HTTP 429 provider responses', () => {
    expect(testProviderErrorPatterns('API call failed: HTTP 429')).toBeTruthy();
  });

  it('matches HTTP 401 provider responses', () => {
    expect(testProviderErrorPatterns('API call failed: HTTP 401 Unauthorized')).toBeTruthy();
  });

  it('matches RESOURCE_EXHAUSTED provider responses', () => {
    expect(testProviderErrorPatterns('Error: RESOURCE_EXHAUSTED')).toBeTruthy();
  });

  it('matches Token Plan usage-limit responses', () => {
    const response = 'API call failed after 3 retries: HTTP 429: Token Plan usage limit reached:';
    expect(testProviderErrorPatterns(response)).toBeTruthy();
    expect(testQuotaPatterns(response)).toBeTruthy();
  });
});

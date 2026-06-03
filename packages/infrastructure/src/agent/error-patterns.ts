export const QUOTA_PATTERNS = [
  /Usage limit reached/i,
  /"statusCode":\s*429/,
  /rate_limit_exceeded/i,
  /quota.*exceed/i,
  /\b429\b/,
] as const;

export const PROVIDER_ERROR_PATTERNS = [
  /AI_APICallError/,
  /AI_APIConnectionError/,
  /provider.*error/i,
  /API error/i,
  /\b5\d{2}\b.*error/i,
  /RESOURCE_EXHAUSTED/i,
  ...QUOTA_PATTERNS,
] as const;

export function testQuotaPatterns(text: string): string | null {
  const lines = text.split('\n');
  for (const line of lines) {
    for (const pattern of QUOTA_PATTERNS) {
      if (pattern.test(line)) return line.trim();
    }
  }
  return null;
}

export function testProviderErrorPatterns(text: string): string | null {
  const lines = text.split('\n');
  for (const line of lines) {
    for (const pattern of PROVIDER_ERROR_PATTERNS) {
      if (pattern.test(line)) return line.trim();
    }
  }
  return null;
}

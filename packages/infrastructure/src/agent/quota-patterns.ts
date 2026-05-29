export const QUOTA_PATTERNS = [
  /Usage limit reached/i,
  /"statusCode":\s*429/,
  /rate_limit_exceeded/i,
  /quota.*exceed/i,
  /\b429\s/,
] as const;

export function testQuotaPatterns(text: string): string | null {
  for (const pattern of QUOTA_PATTERNS) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (pattern.test(line)) return line.trim();
    }
  }
  return null;
}

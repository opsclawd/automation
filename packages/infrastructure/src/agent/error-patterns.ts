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
  /\bProviderError:/i,
  /\bAPIError:/i,
  /\b5\d{2}\b.*error/i,
  /RESOURCE_EXHAUSTED/i,
  ...QUOTA_PATTERNS,
] as const;

const OPENCODE_LOG_LINE = /^\s*(INFO|ERROR|WARN|DEBUG)\s+\d{4}-\d{2}-\d{2}T/;

export function isOpenCodeLogLine(line: string): boolean {
  return OPENCODE_LOG_LINE.test(line);
}

export function testQuotaPatterns(text: string): string | null {
  const lines = text.split('\n');
  for (const line of lines) {
    if (!isOpenCodeLogLine(line)) continue;
    for (const pattern of QUOTA_PATTERNS) {
      if (pattern.test(line)) return line.trim();
    }
  }
  return null;
}

export function testProviderErrorPatterns(text: string): string | null {
  const lines = text.split('\n');
  for (const line of lines) {
    if (!isOpenCodeLogLine(line)) continue;
    for (const pattern of PROVIDER_ERROR_PATTERNS) {
      if (pattern.test(line)) return line.trim();
    }
  }
  return null;
}

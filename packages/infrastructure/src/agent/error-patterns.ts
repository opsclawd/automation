export const QUOTA_PATTERNS = [
  /Usage limit reached/i,
  /"statusCode":\s*429/,
  /rate_limit_exceeded/i,
  /\b(?:status(?:Code)?|HTTP)\D{0,12}429\b/i,
  /Not Enough Credits/i,
] as const;

export const PROVIDER_ERROR_PATTERNS = [
  /AI_APICallError/,
  /AI_APIConnectionError/,
  /\bProviderError:/i,
  /\bAPIError:/i,
  /\b(?:status(?:Code)?|HTTP)\D{0,12}5\d{2}\b.*error/i,
  /RESOURCE_EXHAUSTED/i,
  ...QUOTA_PATTERNS,
] as const;

const OPENCODE_LOG_LINE = /^\s*(INFO|ERROR|WARN|DEBUG)\s+\d{4}-\d{2}-\d{2}T/;

export function isOpenCodeLogLine(line: string): boolean {
  return OPENCODE_LOG_LINE.test(line);
}

export function testQuotaPatterns(
  text: string,
  options?: { structuralOnly?: boolean },
): string | null {
  const structuralOnly = options?.structuralOnly ?? false;
  const lines = text.split('\n');
  for (const line of lines) {
    if (structuralOnly && !isOpenCodeLogLine(line)) continue;
    for (const pattern of QUOTA_PATTERNS) {
      if (pattern.test(line)) return line.trim();
    }
  }
  return null;
}

export function testProviderErrorPatterns(
  text: string,
  options?: { structuralOnly?: boolean },
): string | null {
  const structuralOnly = options?.structuralOnly ?? false;
  const lines = text.split('\n');
  for (const line of lines) {
    if (structuralOnly && !isOpenCodeLogLine(line)) continue;
    for (const pattern of PROVIDER_ERROR_PATTERNS) {
      if (pattern.test(line)) return line.trim();
    }
  }
  return null;
}

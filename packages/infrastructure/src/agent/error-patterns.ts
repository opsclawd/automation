export const QUOTA_PATTERNS = [
  /Usage limit reached/i,
  /"statusCode":\s*429/,
  /rate[\s_-]*limit[\s_-]*exceed/i,
  /\b(?:status(?:Code)?|HTTP)\D{0,12}429\b/i,
  /Not Enough Credits/i,
  /quota[a-zA-Z0-9\s_:,().-]*exceed/i,
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

export const TOKEN_LIMIT_PATTERNS = [
  /context_length_exceeded/i,
  /prompt is too long/i,
  /token[s]?(?![a-zA-Z0-9\s_:,().-]*rate[\s_-]*limit)[a-zA-Z0-9\s_:,().-]*limit[a-zA-Z0-9\s_:,().-]*exceed/i,
  /maximum context length/i,
  /request too large/i,
] as const;

const OPENCODE_LOG_LINE = /^\s*(INFO|ERROR|WARN|DEBUG)\s+\d{4}-\d{2}-\d{2}T/;

export function isOpenCodeLogLine(line: string): boolean {
  return OPENCODE_LOG_LINE.test(line);
}

export function getLastLines(text: string, maxLines?: number): string[] {
  const cleanText = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (maxLines !== undefined) {
    if (maxLines <= 0) {
      return [];
    }
    let startIdx = 0;
    let searchIdx = cleanText.length - 1;
    for (let count = 0; count < maxLines; count++) {
      const nextIdx = cleanText.lastIndexOf('\n', searchIdx);
      if (nextIdx === -1) {
        startIdx = 0;
        break;
      }
      startIdx = nextIdx + 1;
      searchIdx = nextIdx - 1;
    }
    return cleanText.slice(startIdx).split('\n');
  }
  return cleanText.split('\n');
}

function testPatterns(
  text: string,
  patterns: readonly RegExp[],
  options?: { structuralOnly?: boolean; maxLines?: number },
): string | null {
  const structuralOnly = options?.structuralOnly ?? false;
  const lines = getLastLines(text, options?.maxLines);
  for (const line of lines) {
    if (structuralOnly && !isOpenCodeLogLine(line)) continue;
    if (
      line.includes('_PATTERNS=') ||
      line.includes('_PROVIDER_ERROR_PATTERNS') ||
      line.trimStart().startsWith('+')
    ) {
      continue;
    }
    for (const pattern of patterns) {
      if (pattern.test(line)) return line.trim();
    }
  }
  return null;
}

export function testQuotaPatterns(
  text: string,
  options?: { structuralOnly?: boolean; maxLines?: number },
): string | null {
  return testPatterns(text, QUOTA_PATTERNS, options);
}

export function testProviderErrorPatterns(
  text: string,
  options?: { structuralOnly?: boolean; maxLines?: number },
): string | null {
  return testPatterns(text, PROVIDER_ERROR_PATTERNS, options);
}

export function testTokenLimitPatterns(
  text: string,
  options?: { structuralOnly?: boolean; maxLines?: number },
): string | null {
  return testPatterns(text, TOKEN_LIMIT_PATTERNS, options);
}

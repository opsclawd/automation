export const QUOTA_PATTERNS = [
  /Usage limit reached/i,
  /"statusCode":\s*429/,
  /rate_limit_exceeded/i,
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
  /token[s]?[a-zA-Z0-9\s_:,().-]*limit[a-zA-Z0-9\s_:,().-]*exceed/i,
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
    let count = 0;
    for (let i = cleanText.length - 1; i >= 0; i--) {
      if (cleanText[i] === '\n') {
        count++;
        if (count === maxLines) {
          startIdx = i + 1;
          break;
        }
      }
    }
    return cleanText.slice(startIdx).split('\n');
  }
  return cleanText.split('\n');
}

export function testQuotaPatterns(
  text: string,
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
    for (const pattern of QUOTA_PATTERNS) {
      if (pattern.test(line)) return line.trim();
    }
  }
  return null;
}

export function testProviderErrorPatterns(
  text: string,
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
    for (const pattern of PROVIDER_ERROR_PATTERNS) {
      if (pattern.test(line)) return line.trim();
    }
  }
  return null;
}

export function testTokenLimitPatterns(
  text: string,
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
    for (const pattern of TOKEN_LIMIT_PATTERNS) {
      if (pattern.test(line)) return line.trim();
    }
  }
  return null;
}

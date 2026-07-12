export const QUOTA_PATTERNS = [
  /Usage limit reached/i,
  /"statusCode":\s*429/,
  /rate[\s_-]*limit[\s_-]*exceed/i,
  /(?:status(?:Code)?|HTTP)\D{0,12}429\b/i,
  /Not Enough Credits/i,
  /quota[s]?(?:[\s_:,().-]|limit[s]?|rate|is|has|been|daily|monthly)*exceed/i,
] as const;

export const PROVIDER_ERROR_PATTERNS = [
  /AI_APICallError/,
  /AI_APIConnectionError/,
  /\bProviderError:/i,
  /\bAPIError:/i,
  /(?:status(?:Code)?|HTTP)\D{0,12}5\d{2}\b/i,
  /RESOURCE_EXHAUSTED/i,
  ...QUOTA_PATTERNS,
] as const;

export const TOKEN_LIMIT_PATTERNS = [
  /context_length_exceeded/i,
  /prompt is too long/i,
  /token[s]?[a-zA-Z0-9\s_:,().-]*(?<!rate[\s_-]*)limit[a-zA-Z0-9\s_:,().-]*exceed/i,
  /maximum context length/i,
  /request too large/i,
] as const;

const OPENCODE_LOG_LINE = /^\s*(INFO|ERROR|WARN|DEBUG)\s+\d{4}-\d{2}-\d{2}T/;
// bash set -x trace lines (+ cmd, ++ cmd, indented variants) and shell variable
// assignment/export lines that echo pattern values — both are false-positive sources.
const BASH_TRACE_LINE = /^\s*\+{1,3} /;
const SHELL_ASSIGNMENT_LINE = /^\s*(?:export\s+)?\w+=(['"]?)/;
// Markdown table rows (lines starting with |) — codex echoes its prompt to stderr,
// which may contain documentation tables listing these error type names as identifiers.
const MARKDOWN_TABLE_LINE = /^\s*\|/;

export function isOpenCodeLogLine(line: string): boolean {
  return OPENCODE_LOG_LINE.test(line);
}

export function getLastLines(text: string, maxLines?: number): string[] {
  const cleanText = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (maxLines !== undefined) {
    if (maxLines <= 0) {
      return [];
    }
    let count = 0;
    let idx = cleanText.length;
    while (count < maxLines && idx > 0) {
      const nextIdx = cleanText.lastIndexOf('\n', idx - 1);
      if (nextIdx === -1) {
        idx = -1;
        break;
      }
      idx = nextIdx;
      count++;
    }
    if (count < maxLines && idx === 0) {
      idx = -1;
    }
    return cleanText.slice(idx + 1).split('\n');
  }
  return cleanText.split('\n');
}

export function getLinesToScan(text: string, maxLines?: number): string[] {
  const cleanText = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (maxLines === undefined) {
    return cleanText.split('\n');
  }
  if (maxLines <= 0) {
    return [];
  }

  // Find end index of the first maxLines lines
  let firstCount = 0;
  let firstIdx = -1;
  let firstFinished = false;
  while (firstCount < maxLines) {
    const nextIdx = cleanText.indexOf('\n', firstIdx + 1);
    if (nextIdx === -1) {
      firstFinished = true;
      break;
    }
    firstIdx = nextIdx;
    firstCount++;
  }

  if (firstFinished) {
    // The entire text is less than or equal to maxLines lines
    return cleanText.split('\n');
  }

  // Find start index of the last maxLines lines
  let lastCount = 0;
  let lastIdx = cleanText.length;
  while (lastCount < maxLines && lastIdx > 0) {
    const nextIdx = cleanText.lastIndexOf('\n', lastIdx - 1);
    if (nextIdx === -1) {
      lastIdx = -1;
      break;
    }
    lastIdx = nextIdx;
    lastCount++;
  }
  if (lastCount < maxLines && lastIdx === 0) {
    lastIdx = -1;
  }
  const lastStartIdx = lastIdx + 1;

  // If they overlap, just return the whole text
  if (firstIdx >= lastStartIdx) {
    return cleanText.split('\n');
  }

  // Otherwise, combine them
  const firstLines = cleanText.slice(0, firstIdx).split('\n');
  const lastLines = cleanText.slice(lastStartIdx).split('\n');
  return [...firstLines, ...lastLines];
}

function testPatterns(
  text: string,
  patterns: readonly RegExp[],
  options?: { structuralOnly?: boolean; maxLines?: number },
): string | null {
  const structuralOnly = options?.structuralOnly ?? false;
  const lines = getLinesToScan(text, options?.maxLines);
  for (const line of lines) {
    if (structuralOnly && !isOpenCodeLogLine(line)) continue;
    if (
      BASH_TRACE_LINE.test(line) ||
      SHELL_ASSIGNMENT_LINE.test(line) ||
      MARKDOWN_TABLE_LINE.test(line)
    )
      continue;
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

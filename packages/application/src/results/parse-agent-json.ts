/**
 * Escapes raw (unescaped) control characters (0x00-0x1F) that appear inside
 * JSON string literals. Agent-generated result.json files occasionally
 * contain a literal newline/tab where an escaped `\n`/`\t` was intended —
 * otherwise-valid JSON except for this one violation, which JSON.parse
 * rejects with "Bad control character in string literal". Control
 * characters outside string literals (structural whitespace between
 * tokens) are untouched.
 */
export function sanitizeJsonControlChars(raw: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const code = raw.charCodeAt(i);

    if (!inString) {
      if (ch === '"') inString = true;
      result += ch;
      continue;
    }

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      result += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = false;
      result += ch;
      continue;
    }

    if (code <= 0x1f) {
      switch (ch) {
        case '\n':
          result += '\\n';
          break;
        case '\r':
          result += '\\r';
          break;
        case '\t':
          result += '\\t';
          break;
        case '\b':
          result += '\\b';
          break;
        case '\f':
          result += '\\f';
          break;
        default:
          result += '\\u' + code.toString(16).padStart(4, '0');
      }
      continue;
    }

    result += ch;
  }

  return result;
}

/**
 * JSON.parse, tolerant of stray unescaped control characters inside string
 * literals. Use for agent-generated result.json artifacts, which are not
 * guaranteed to produce strictly spec-compliant JSON.
 */
export function parseAgentResultJson<T = unknown>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    if (err instanceof SyntaxError && /control character/i.test(err.message)) {
      return JSON.parse(sanitizeJsonControlChars(raw)) as T;
    }
    throw err;
  }
}

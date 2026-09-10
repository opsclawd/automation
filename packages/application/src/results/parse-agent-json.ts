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

export const UNESCAPED_QUOTE_OR_BACKSLASH_RE =
  /Expected ',' or (?:'}'|']')|Unexpected token|Unterminated string|Expected double-quoted property name|Unexpected non-whitespace character|bad escaped character|bad unicode escape|invalid escape/i;

const KEY_CONTINUATION_RE = /\s*"(?:\\.|[^"\\])*"\s*:/y;
const VALUE_CONTINUATION_RE = /\s*(?:"|-?\d|true\b|false\b|null\b|\{|\[)/y;

/**
 * Best-effort sanitizer for unescaped inner quotes and invalid backslash escapes
 * in agent-generated JSON strings.
 */
export function sanitizeJsonUnescapedInnerQuotes(raw: string): string {
  let result = '';
  let inString = false;
  let isKey = false;
  let expectingKey = false;
  const containerStack: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;

    if (!inString) {
      if (ch === '{') {
        containerStack.push('{');
        expectingKey = true;
        result += ch;
        continue;
      }
      if (ch === '}') {
        containerStack.pop();
        expectingKey = false;
        result += ch;
        continue;
      }
      if (ch === '[') {
        containerStack.push('[');
        expectingKey = false;
        result += ch;
        continue;
      }
      if (ch === ']') {
        containerStack.pop();
        expectingKey = false;
        result += ch;
        continue;
      }
      if (ch === ':') {
        if (containerStack[containerStack.length - 1] === '{') {
          expectingKey = false;
        }
        result += ch;
        continue;
      }
      if (ch === ',') {
        if (containerStack[containerStack.length - 1] === '{') {
          expectingKey = true;
        }
        result += ch;
        continue;
      }

      if (ch === '"') {
        inString = true;
        isKey = containerStack[containerStack.length - 1] === '{' && expectingKey;
        result += ch;
        continue;
      }

      result += ch;
      continue;
    }

    // --- We are inString ---

    // Handle backslash escapes inside strings
    if (ch === '\\') {
      const next = i + 1 < raw.length ? raw[i + 1] : '';
      if (next === '"') {
        result += '\\"';
        i++;
        continue;
      }
      if (next === '\\') {
        result += '\\\\';
        i++;
        continue;
      }
      if (next === '/') {
        result += '\\/';
        i++;
        continue;
      }
      if (next === 'b' || next === 'f' || next === 'n' || next === 'r' || next === 't') {
        result += '\\' + next;
        i++;
        continue;
      }
      if (next === 'u') {
        const hex = raw.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          result += '\\u' + hex;
          i += 5;
          continue;
        }
        // Invalid \u escape (e.g. \utils): escape the leading backslash as \\
        result += '\\\\';
        continue;
      }
      // Any other character following backslash is an invalid escape: escape the leading backslash
      result += '\\\\';
      continue;
    }

    // Handle quote inside string
    if (ch === '"') {
      // Find next non-whitespace character after this quote
      let j = i + 1;
      while (
        j < raw.length &&
        (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\n' || raw[j] === '\r')
      ) {
        j++;
      }

      if (j >= raw.length) {
        // Trailing quote at EOF - treat as real closing quote
        inString = false;
        result += ch;
        continue;
      }

      const nextChar = raw[j]!;

      // If this was a property key, it should be closed before a colon
      if (isKey) {
        if (nextChar === ':') {
          inString = false;
          isKey = false;
          result += ch;
          continue;
        }
        // Inner quote in key: escape it
        result += '\\"';
        continue;
      }

      // This is a value string or array element
      if (nextChar === '}' || nextChar === ']') {
        // Look ahead past the delimiter to see if this delimiter actually closes a container
        let k = j + 1;
        while (
          k < raw.length &&
          (raw[k] === ' ' || raw[k] === '\t' || raw[k] === '\n' || raw[k] === '\r')
        ) {
          k++;
        }

        const currentContainer = containerStack[containerStack.length - 1];
        // If delimiter does not match current container, this quote is quoting the delimiter
        if (
          (nextChar === '}' && currentContainer !== '{') ||
          (nextChar === ']' && currentContainer !== '[')
        ) {
          result += '\\"';
          continue;
        }

        if (k >= raw.length) {
          // Delimiter at end of document: real closing quote only if it closes the root container
          if (containerStack.length === 1) {
            inString = false;
            result += ch;
            continue;
          }
          result += '\\"';
          continue;
        }

        const afterClose = raw[k]!;
        // After a container closes, the next token can only be ',', '}', ']', or EOF.
        // If anything else follows (e.g. letters in "cites token "}" in code"),
        // the quote is an inner quote quoting the delimiter literal.
        if (afterClose !== ',' && afterClose !== '}' && afterClose !== ']') {
          result += '\\"';
          continue;
        }

        // If this closing delimiter would close the root container (containerStack.length === 1),
        // no subsequent non-whitespace token (like a comma or brace) is valid in JSON.
        if (containerStack.length === 1) {
          result += '\\"';
          continue;
        }

        // For nested containers, verify what follows:
        if (afterClose === ',') {
          let m = k + 1;
          while (
            m < raw.length &&
            (raw[m] === ' ' || raw[m] === '\t' || raw[m] === '\n' || raw[m] === '\r')
          ) {
            m++;
          }
          const parentContainer = containerStack[containerStack.length - 2];
          let validAfterComma = false;
          if (parentContainer === '{') {
            KEY_CONTINUATION_RE.lastIndex = m;
            validAfterComma = KEY_CONTINUATION_RE.test(raw);
          } else if (parentContainer === '[') {
            VALUE_CONTINUATION_RE.lastIndex = m;
            validAfterComma = VALUE_CONTINUATION_RE.test(raw);
          }
          if (!validAfterComma) {
            result += '\\"';
            continue;
          }
        }

        // String ends immediately before container close
        inString = false;
        result += ch;
        continue;
      }

      if (nextChar === ',') {
        // Check what follows the comma
        let k = j + 1;
        while (
          k < raw.length &&
          (raw[k] === ' ' || raw[k] === '\t' || raw[k] === '\n' || raw[k] === '\r')
        ) {
          k++;
        }
        const currentContainer = containerStack[containerStack.length - 1];

        let isValidContinuation = false;
        if (currentContainer === '{') {
          // In an object, what follows must be a property key followed by a colon
          KEY_CONTINUATION_RE.lastIndex = k;
          isValidContinuation = KEY_CONTINUATION_RE.test(raw);
        } else if (currentContainer === '[') {
          // In an array, what follows must be a valid JSON value
          VALUE_CONTINUATION_RE.lastIndex = k;
          isValidContinuation = VALUE_CONTINUATION_RE.test(raw);
        } else {
          // Top-level or unknown container: check if it looks like a key or value
          KEY_CONTINUATION_RE.lastIndex = k;
          VALUE_CONTINUATION_RE.lastIndex = k;
          isValidContinuation = KEY_CONTINUATION_RE.test(raw) || VALUE_CONTINUATION_RE.test(raw);
        }

        if (isValidContinuation) {
          inString = false;
          result += ch;
          continue;
        }

        // Not a valid JSON continuation - comma was part of prose inside the string
        result += '\\"';
        continue;
      }

      if (nextChar === ':') {
        // A colon immediately following a value string without an unclosed key is prose punctuation
        result += '\\"';
        continue;
      }

      // Any other character (e.g. letter, digit, word, dot, quote) means prose continues
      result += '\\"';
      continue;
    }

    result += ch;
  }

  return result;
}

/**
 * JSON.parse, tolerant of stray unescaped control characters, unescaped inner quotes,
 * and invalid backslash escapes inside string literals. Use for agent-generated result.json
 * artifacts, which are not guaranteed to produce strictly spec-compliant JSON.
 */
export function parseAgentResultJson<T = unknown>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    if (err instanceof SyntaxError) {
      if (/control character/i.test(err.message)) {
        try {
          return JSON.parse(sanitizeJsonControlChars(raw)) as T;
        } catch {
          // fall through to try quote sanitizer then control sanitizer
        }
      }
      if (
        /control character/i.test(err.message) ||
        UNESCAPED_QUOTE_OR_BACKSLASH_RE.test(err.message)
      ) {
        try {
          // Quote pass runs first to establish valid string boundaries,
          // then control pass handles any remaining raw control characters.
          return JSON.parse(sanitizeJsonControlChars(sanitizeJsonUnescapedInnerQuotes(raw))) as T;
        } catch {
          // fall through to rethrow original error
        }
      }
    }
    throw err;
  }
}

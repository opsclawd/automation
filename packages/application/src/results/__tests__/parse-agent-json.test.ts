import { describe, it, expect } from 'vitest';
import {
  parseAgentResultJson,
  sanitizeJsonControlChars,
  sanitizeJsonUnescapedInnerQuotes,
  UNESCAPED_QUOTE_OR_BACKSLASH_RE,
} from '../parse-agent-json.js';

describe('sanitizeJsonControlChars', () => {
  it('escapes a raw newline inside a string literal', () => {
    const raw = '{"summary": "line one\nline two"}';
    const sanitized = sanitizeJsonControlChars(raw);
    expect(() => JSON.parse(sanitized)).not.toThrow();
    expect(JSON.parse(sanitized)).toEqual({ summary: 'line one\nline two' });
  });

  it('does not touch structural whitespace outside string literals', () => {
    const raw = '{\n  "a": "b"\n}';
    expect(sanitizeJsonControlChars(raw)).toBe(raw);
  });

  it('leaves already-escaped sequences untouched', () => {
    const raw = '{"summary": "line one\\nline two"}';
    expect(sanitizeJsonControlChars(raw)).toBe(raw);
  });

  it('preserves escaped quotes and backslashes inside strings', () => {
    const raw = '{"a": "quote: \\" backslash: \\\\ then a raw\ttab"}';
    const sanitized = sanitizeJsonControlChars(raw);
    expect(JSON.parse(sanitized)).toEqual({ a: 'quote: " backslash: \\ then a raw\ttab' });
  });

  it('escapes multiple different control characters in one document', () => {
    const raw = '{"a": "tab:\there", "b": "cr:\rhere"}';
    const sanitized = sanitizeJsonControlChars(raw);
    expect(JSON.parse(sanitized)).toEqual({ a: 'tab:\there', b: 'cr:\rhere' });
  });
});

describe('sanitizeJsonUnescapedInnerQuotes', () => {
  it('repairs an unescaped inner quote around a code identifier', () => {
    const raw = '{"evidence": "cites "ApprovedVisualProductionInput" type"}';
    const sanitized = sanitizeJsonUnescapedInnerQuotes(raw);
    expect(() => JSON.parse(sanitized)).not.toThrow();
    expect(JSON.parse(sanitized)).toEqual({
      evidence: 'cites "ApprovedVisualProductionInput" type',
    });
  });

  it('repairs field-access chain quotes matching the issue failure signature', () => {
    const raw = '{"evidence": "cites "resolvedApprovedCandidateMedia.media.key" identifier"}';
    const sanitized = sanitizeJsonUnescapedInnerQuotes(raw);
    expect(JSON.parse(sanitized)).toEqual({
      evidence: 'cites "resolvedApprovedCandidateMedia.media.key" identifier',
    });
  });

  it('does not prematurely terminate on prose citation followed by a comma (Finding 1 guard)', () => {
    const raw = '{"evidence": "Inspected "src/index.ts", line 42 and confirmed the fix"}';
    const sanitized = sanitizeJsonUnescapedInnerQuotes(raw);
    expect(() => JSON.parse(sanitized)).not.toThrow();
    expect(JSON.parse(sanitized)).toEqual({
      evidence: 'Inspected "src/index.ts", line 42 and confirmed the fix',
    });
  });

  it('preserves valid JSON strings ending before a comma or brace', () => {
    const raw = '{\n  "verdict": "APPROVE",\n  "summary": "All tests pass."\n}';
    expect(sanitizeJsonUnescapedInnerQuotes(raw)).toBe(raw);
  });

  it('preserves already-escaped inner quotes', () => {
    const raw = '{"evidence": "cites \\"ApprovedVisualProductionInput\\" type"}';
    expect(sanitizeJsonUnescapedInnerQuotes(raw)).toBe(raw);
    expect(JSON.parse(sanitizeJsonUnescapedInnerQuotes(raw))).toEqual({
      evidence: 'cites "ApprovedVisualProductionInput" type',
    });
  });

  it('escapes invalid backslash in Windows-style path with single backslashes (Finding 2)', () => {
    const raw = '{"path": "C:\\Users\\file.ts"}';
    const sanitized = sanitizeJsonUnescapedInnerQuotes(raw);
    expect(() => JSON.parse(sanitized)).not.toThrow();
    // \f is inherently ambiguous because \f is a valid JSON escape sequence for form feed;
    // preserving valid JSON escapes while escaping unrecognized ones is an accepted tradeoff and corruption is accepted.
    expect(JSON.parse(sanitized)).toEqual({
      path: 'C:\\Users\x0cile.ts', // \f is form feed
    });
  });

  it('escapes invalid unicode escape such as \\utils where \\u is not 4 hex digits (Finding 2)', () => {
    const raw = '{"dir": "\\utils\\test"}';
    const sanitized = sanitizeJsonUnescapedInnerQuotes(raw);
    expect(() => JSON.parse(sanitized)).not.toThrow();
    expect(JSON.parse(sanitized)).toEqual({
      dir: '\\utils\test', // \t is tab
    });
  });

  it('handles multiple inner quotes in a single string', () => {
    const raw = '{"evidence": "Compare "foo", "bar", and "baz" values"}';
    const sanitized = sanitizeJsonUnescapedInnerQuotes(raw);
    expect(JSON.parse(sanitized)).toEqual({
      evidence: 'Compare "foo", "bar", and "baz" values',
    });
  });

  it('handles inner quotes in array string elements', () => {
    const raw = '{"items": ["inspected "first.ts", line 10", "second.ts"]}';
    const sanitized = sanitizeJsonUnescapedInnerQuotes(raw);
    expect(JSON.parse(sanitized)).toEqual({
      items: ['inspected "first.ts", line 10', 'second.ts'],
    });
  });

  it('handles inner quotes around delimiter literals like "}" and "]"', () => {
    const raw1 = '{"evidence": "cites token "}" in code"}';
    expect(JSON.parse(sanitizeJsonUnescapedInnerQuotes(raw1))).toEqual({
      evidence: 'cites token "}" in code',
    });
    const raw2 = '{"items": ["quotes "]" token", "next"]}';
    expect(JSON.parse(sanitizeJsonUnescapedInnerQuotes(raw2))).toEqual({
      items: ['quotes "]" token', 'next'],
    });
  });
});

describe('UNESCAPED_QUOTE_OR_BACKSLASH_RE', () => {
  it('matches V8 SyntaxError messages for unescaped quotes', () => {
    let message = '';
    try {
      JSON.parse('{"a": "b" "c"}');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(UNESCAPED_QUOTE_OR_BACKSLASH_RE.test(message)).toBe(true);
  });

  it('matches V8 SyntaxError messages for unescaped quote in array element', () => {
    let message = '';
    try {
      JSON.parse('{"new_findings":[{"files":["packages/app/src/"foo".ts"]}]}');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/Expected ',' or '\]'/i);
    expect(UNESCAPED_QUOTE_OR_BACKSLASH_RE.test(message)).toBe(true);
  });

  it('matches V8 SyntaxError messages for premature closure before non-whitespace', () => {
    let message = '';
    try {
      JSON.parse('{"evidence": "quotes "}" in code"}');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/Unexpected non-whitespace character/i);
    expect(UNESCAPED_QUOTE_OR_BACKSLASH_RE.test(message)).toBe(true);
  });

  it('matches V8 SyntaxError messages for unterminated string', () => {
    let message = '';
    try {
      JSON.parse('{"a": "b", "c}');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/Unterminated string/i);
    expect(UNESCAPED_QUOTE_OR_BACKSLASH_RE.test(message)).toBe(true);
  });

  it('matches V8 SyntaxError messages for bad escaped characters', () => {
    let message = '';
    try {
      JSON.parse('{"a": "\\q"}');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/bad escaped character/i);
    expect(UNESCAPED_QUOTE_OR_BACKSLASH_RE.test(message)).toBe(true);
  });

  it('matches V8 SyntaxError messages for bad unicode escapes', () => {
    let message = '';
    try {
      JSON.parse('{"a": "\\u12"}');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/bad unicode escape/i);
    expect(UNESCAPED_QUOTE_OR_BACKSLASH_RE.test(message)).toBe(true);
  });
});

describe('parseAgentResultJson', () => {
  it('parses well-formed JSON directly without modification', () => {
    expect(parseAgentResultJson('{"verdict":"APPROVE"}')).toEqual({ verdict: 'APPROVE' });
  });

  it('recovers from a raw control character in a string literal', () => {
    const raw = '{\n  "verdict": "APPROVE",\n  "summary": "All findings resolved.\n"\n}\n';
    expect(parseAgentResultJson(raw)).toEqual({
      verdict: 'APPROVE',
      summary: 'All findings resolved.\n',
    });
  });

  it('recovers from an unescaped inner quote in evidence field (#1156 real failure shape)', () => {
    const raw = [
      '{',
      '  "verdict": "APPROVE",',
      '  "evaluations": [',
      '    {',
      '      "finding_id": "Finding 1",',
      '      "resolved": true,',
      '      "evidence": "cites "resolvedApprovedCandidateMedia.media.key" in schema"',
      '    }',
      '  ],',
      '  "summary": "Verified all findings."',
      '}',
    ].join('\n');

    const parsed = parseAgentResultJson<{
      verdict: string;
      evaluations: Array<{ finding_id: string; resolved: boolean; evidence: string }>;
      summary: string;
    }>(raw);

    expect(parsed.verdict).toBe('APPROVE');
    expect(parsed.evaluations[0]?.evidence).toBe(
      'cites "resolvedApprovedCandidateMedia.media.key" in schema',
    );
    expect(parsed.summary).toBe('Verified all findings.');
  });

  it('recovers from both raw control characters and unescaped quotes', () => {
    const raw = '{\n  "verdict": "APPROVE",\n  "evidence": "line one\nwith "quoted" code"\n}';
    const parsed = parseAgentResultJson<{ verdict: string; evidence: string }>(raw);
    expect(parsed.verdict).toBe('APPROVE');
    expect(parsed.evidence).toBe('line one\nwith "quoted" code');
  });

  it('recovers from an odd number of stray quotes plus a raw newline', () => {
    const raw = '{\n  "a": "x "y",\n  "b": "z"\n}';
    const parsed = parseAgentResultJson<{ a: string; b: string }>(raw);
    expect(parsed.a).toBe('x "y');
    expect(parsed.b).toBe('z');
  });

  it('recovers from an unescaped quote in an array element via parseAgentResultJson', () => {
    const raw = '{"new_findings":[{"files":["packages/app/src/"foo".ts"]}]}';
    const parsed = parseAgentResultJson<{
      new_findings: Array<{ files: string[] }>;
    }>(raw);
    expect(parsed.new_findings[0]?.files).toEqual(['packages/app/src/"foo".ts']);
  });

  it('recovers from an evidence string quoting the literal code token "}"', () => {
    const raw =
      '{\n  "verdict": "APPROVE",\n  "evidence": "cites token "}" in code",\n  "summary": "done"\n}';
    const parsed = parseAgentResultJson<{
      verdict: string;
      evidence: string;
      summary: string;
    }>(raw);
    expect(parsed.verdict).toBe('APPROVE');
    expect(parsed.evidence).toBe('cites token "}" in code');
    expect(parsed.summary).toBe('done');
  });

  it('recovers from an invalid backslash in a path string literal', () => {
    const raw = '{"summary": "Checked C:\\Users\\file.ts and found no issues"}';
    const parsed = parseAgentResultJson<{ summary: string }>(raw);
    expect(parsed.summary).toBe('Checked C:\\Users\x0cile.ts and found no issues');
  });

  it('recovers from an invalid unicode escape like \\utils', () => {
    const raw = '{"summary": "Checked \\utils\\test.ts and found no issues"}';
    const parsed = parseAgentResultJson<{ summary: string }>(raw);
    expect(parsed.summary).toBe('Checked \\utils\test.ts and found no issues');
  });

  it('reproduces the exact failure from run issue-128 follow-up-review', () => {
    const raw =
      '{\n  "verdict": "APPROVE",\n  "evaluations": [],\n  "new_findings": [],\n' +
      '  "summary": "No new blocking defect was found.\n"\n}\n';
    const result = parseAgentResultJson<{ verdict: string; summary: string }>(raw);
    expect(result.verdict).toBe('APPROVE');
    expect(result.summary).toContain('No new blocking defect was found.');
  });

  it('still throws on genuinely invalid JSON unrelated to control characters', () => {
    expect(() => parseAgentResultJson('{not json')).toThrow();
  });
});

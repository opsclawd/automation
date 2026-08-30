import { describe, it, expect } from 'vitest';
import { parseAgentResultJson, sanitizeJsonControlChars } from '../parse-agent-json.js';

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

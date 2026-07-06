import { describe, it, expect } from 'vitest';
import { buildSynthesisPrompt } from '../synthesize-from-transcript.js';

const SAMPLE_INPUT = {
  artifactPath: 'implementation-log.md',
  tail: '... reasoning ...\n**Status:** DONE\nFiles changed: foo.ts\n',
  baseSha: 'abc123',
  headSha: 'def456',
  gitLog: 'commit def456: implement fix',
  diffSummary: 'diff --git a/foo.ts b/foo.ts\n+const x = 1;',
  primaryInvocationId: '00000000-0000-0000-0000-000000000001',
};

describe('buildSynthesisPrompt', () => {
  it('includes the artifact path the writer must produce', () => {
    const prompt = buildSynthesisPrompt(SAMPLE_INPUT);
    expect(prompt).toContain('./implementation-log.md');
    expect(prompt).toContain('implementation-log.md');
  });

  it('includes the git log and diff summary for cross-verification', () => {
    const prompt = buildSynthesisPrompt(SAMPLE_INPUT);
    expect(prompt).toContain('commit def456: implement fix');
    expect(prompt).toContain('diff --git a/foo.ts b/foo.ts');
    expect(prompt).toContain('Base SHA: abc123');
    expect(prompt).toContain('HEAD SHA: def456');
  });

  it('wraps the transcript tail in a fenced code block', () => {
    const prompt = buildSynthesisPrompt(SAMPLE_INPUT);
    expect(prompt).toContain('```');
    expect(prompt).toContain('**Status:** DONE');
  });

  it('tells the writer not to modify anything other than the artifact', () => {
    const prompt = buildSynthesisPrompt(SAMPLE_INPUT);
    expect(prompt).toMatch(/Do NOT modify any code or any file other than implementation-log\.md/);
  });

  it('mentions the BLOCKED fallback when transcript contradicts diff', () => {
    const prompt = buildSynthesisPrompt(SAMPLE_INPUT);
    expect(prompt).toContain('Status: BLOCKED');
  });

  it('does not mention runtime-specific tool names', () => {
    const prompt = buildSynthesisPrompt(SAMPLE_INPUT);
    expect(prompt).not.toMatch(/\bopencode\b/);
    expect(prompt).not.toMatch(/\bantigravity\b/);
    expect(prompt).not.toMatch(/\bcodex\b/);
    expect(prompt).not.toMatch(/\bclaude-code\b/);
  });
});

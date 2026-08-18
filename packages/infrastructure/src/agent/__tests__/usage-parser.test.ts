import { describe, it, expect, vi } from 'vitest';
import { extractTokenUsageFromText } from '../usage-parser.js';

describe('extractTokenUsageFromText', () => {
  it('parses JSON tokens payload embedded in a line', () => {
    const text = 'INFO service=llm tokens={"input":1500,"output":300,"cacheRead":120,"reasoningTokens":50}\n';
    const usage = extractTokenUsageFromText(text);
    expect(usage).toEqual({
      inputTokens: 1500,
      outputTokens: 300,
      cachedTokens: 120,
      reasoningTokens: 50,
    });
  });

  it('parses snake_case JSON field names in log lines', () => {
    const text = 'INFO tokens={"input_tokens":2000,"output_tokens":400,"cache_read_input_tokens":500,"reasoning_tokens":100}\n';
    const usage = extractTokenUsageFromText(text);
    expect(usage).toEqual({
      inputTokens: 2000,
      outputTokens: 400,
      cachedTokens: 500,
      reasoningTokens: 100,
    });
  });

  it('parses text summary lines with Tokens: X in / Y out format', () => {
    const text = 'Processing complete.\nTokens: 1,234 in / 567 out\nCache read: 89\n';
    const usage = extractTokenUsageFromText(text);
    expect(usage).toEqual({
      inputTokens: 1234,
      outputTokens: 567,
      cachedTokens: 89,
    });
  });

  it('parses text summary lines with Input tokens / Output tokens format', () => {
    const text = 'Input tokens: 4,500\nOutput tokens: 1,200\nReasoning tokens: 300\n';
    const usage = extractTokenUsageFromText(text);
    expect(usage).toEqual({
      inputTokens: 4500,
      outputTokens: 1200,
      reasoningTokens: 300,
    });
  });

  it('emits a warning on malformed JSON lines', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const text = 'tokens={invalid_json_content}\n';
    const usage = extractTokenUsageFromText(text, { runtime: 'test-runtime', logPath: '/tmp/test.log' });
    expect(usage).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[test-runtime] Failed to parse JSON token line in /tmp/test.log'),
    );
    warnSpy.mockRestore();
  });

  it('returns undefined for empty text or text without usage', () => {
    expect(extractTokenUsageFromText('')).toBeUndefined();
    expect(extractTokenUsageFromText('No token info here')).toBeUndefined();
  });
});

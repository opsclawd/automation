export interface ExtractedUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
}

/**
 * Parses token usage from text or JSON logs produced by agent CLIs.
 * Supports:
 * 1) JSON objects containing input/output/prompt/completion/cache/reasoning keys
 * 2) JSON lines or key-value pairs (tokens={...}, usage={...})
 * 3) Text summary lines:
 *    - "Tokens: 1,234 input, 567 output" / "Tokens: 1234 in / 567 out"
 *    - "Input tokens: 1,234" / "Output tokens: 567" / "Cache read: 42"
 *    - "1234 prompt tokens, 567 completion tokens"
 */
export function extractTokenUsageFromText(
  content: string,
  opts?: { runtime?: string; logPath?: string },
): ExtractedUsage | undefined {
  if (!content || !content.trim()) return undefined;

  const runtime = opts?.runtime ?? 'agent';
  const logPath = opts?.logPath ?? 'log';

  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cachedTokens = 0;
  let hasUsage = false;

  const lines = content.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;

    // A) Check for JSON objects or JSON payloads embedded in line
    const jsonMatch =
      /(?:tokens|usage)\s*[:=]\s*(\{.*\})/i.exec(line) ||
      /(\{(?:.*?"(?:input|prompt|output|completion|cache|reasoning)"|.*?"(?:input_tokens|output_tokens)").*?\})/i.exec(line);

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]!);
        const input =
          typeof parsed.input === 'number'
            ? parsed.input
            : typeof parsed.input_tokens === 'number'
              ? parsed.input_tokens
              : typeof parsed.prompt_tokens === 'number'
                ? parsed.prompt_tokens
                : typeof parsed.inputTokens === 'number'
                  ? parsed.inputTokens
                  : 0;

        const output =
          typeof parsed.output === 'number'
            ? parsed.output
            : typeof parsed.output_tokens === 'number'
              ? parsed.output_tokens
              : typeof parsed.completion_tokens === 'number'
                ? parsed.completion_tokens
                : typeof parsed.outputTokens === 'number'
                  ? parsed.outputTokens
                  : 0;

        const cached =
          typeof parsed.cacheRead === 'number'
            ? parsed.cacheRead
            : typeof parsed.cache?.read === 'number'
              ? parsed.cache.read
              : typeof parsed.cache_read === 'number'
                ? parsed.cache_read
                : typeof parsed.cache_read_input_tokens === 'number'
                  ? parsed.cache_read_input_tokens
                  : typeof parsed.cached_tokens === 'number'
                    ? parsed.cached_tokens
                    : typeof parsed.cachedTokens === 'number'
                      ? parsed.cachedTokens
                      : typeof parsed.cache_read_tokens === 'number'
                        ? parsed.cache_read_tokens
                        : 0;

        const reasoning =
          typeof parsed.reasoning === 'number'
            ? parsed.reasoning
            : typeof parsed.reasoningTokens === 'number'
              ? parsed.reasoningTokens
              : typeof parsed.reasoning_tokens === 'number'
                ? parsed.reasoning_tokens
                : typeof parsed.completion_tokens_details?.reasoning_tokens === 'number'
                  ? parsed.completion_tokens_details.reasoning_tokens
                  : 0;

        if (input > 0 || output > 0 || cached > 0 || reasoning > 0) {
          inputTokens += input;
          outputTokens += output;
          cachedTokens += cached;
          reasoningTokens += reasoning;
          hasUsage = true;
          continue;
        }
      } catch (err) {
        console.warn(`[${runtime}] Failed to parse JSON token line in ${logPath}: ${String(err)}`);
      }
    }

    // B) Text summary patterns:
    const tokensSummaryMatch = /Tokens:\s*([\d,]+)\s*(?:in|input)[^,\d]*[\/,]\s*([\d,]+)\s*(?:out|output)/i.exec(line);
    if (tokensSummaryMatch) {
      inputTokens += parseInt(tokensSummaryMatch[1]!.replace(/,/g, ''), 10);
      outputTokens += parseInt(tokensSummaryMatch[2]!.replace(/,/g, ''), 10);
      hasUsage = true;
    }

    const inMatch = /(?:Input|Prompt)\s*tokens?\s*[:=]?\s*([\d,]+)/i.exec(line);
    if (inMatch) {
      inputTokens += parseInt(inMatch[1]!.replace(/,/g, ''), 10);
      hasUsage = true;
    }

    const outMatch = /(?:Output|Completion)\s*tokens?\s*[:=]?\s*([\d,]+)/i.exec(line);
    if (outMatch) {
      outputTokens += parseInt(outMatch[1]!.replace(/,/g, ''), 10);
      hasUsage = true;
    }

    const cacheMatch = /(?:Cache\s*(?:read|hits?)|Cached\s*tokens?)\s*[:=]?\s*([\d,]+)/i.exec(line);
    if (cacheMatch) {
      cachedTokens += parseInt(cacheMatch[1]!.replace(/,/g, ''), 10);
      hasUsage = true;
    }

    const reasMatch = /Reasoning\s*tokens?\s*[:=]?\s*([\d,]+)/i.exec(line);
    if (reasMatch) {
      reasoningTokens += parseInt(reasMatch[1]!.replace(/,/g, ''), 10);
      hasUsage = true;
    }
  }

  if (!hasUsage) return undefined;

  return {
    inputTokens,
    outputTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
  };
}

/**
 * Caps diff text embedded in review-fix prompts to a safe character budget.
 *
 * follow-up-review's `complete_diff` variable is the cumulative diff from
 * the run's original start commit to current HEAD (see follow-up-review.ts).
 * For a long-running, many-iteration issue, this diff grows unboundedly with
 * every fix round and is re-embedded in full on every single follow-up-review
 * invocation. Agent backends (confirmed via opencode's `turn/start` JSON-RPC
 * error: "Input exceeds the maximum length of 1048576 characters") enforce a
 * hard input-size limit far below what a large epic's cumulative diff can
 * reach (observed: 34,253,226 characters on issue #426, ~32x the limit).
 * That failure is deterministic, not transient: retrying the same oversized
 * prompt can never succeed. Capping the diff text keeps every invocation
 * within a safe budget regardless of how many iterations a run accumulates.
 */
export const DEFAULT_DIFF_CHAR_BUDGET = 250_000;

export interface DiffBudgetResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalChars: number;
}

/**
 * Returns `diff` unchanged if it fits within `maxChars`. Otherwise returns a
 * head+tail excerpt (half the budget from the start, half from the end) with
 * an explanatory marker in between, so the reviewer still sees how the
 * change begins and ends without exceeding the budget. The beginning of a
 * diff carries the earliest-touched files' hunks and the end carries the
 * most recent; callers that need the authoritative record of what changed
 * since the previous review should prefer a narrower diff (e.g. since the
 * last review head) over this cumulative one.
 */
export function capDiffForPrompt(
  diff: string,
  maxChars: number = DEFAULT_DIFF_CHAR_BUDGET,
): DiffBudgetResult {
  const originalChars = diff.length;
  if (originalChars <= maxChars) {
    return { text: diff, truncated: false, originalChars };
  }

  const marker = `\n\n... [diff truncated: ${originalChars.toLocaleString()} characters exceeds the ${maxChars.toLocaleString()}-character prompt budget; showing the first and last portions. Rely on the finding ledger and the since-last-review diff for the authoritative record of what changed and what remains unresolved.] ...\n\n`;
  const remaining = Math.max(maxChars - marker.length, 0);
  const headChars = Math.ceil(remaining / 2);
  const tailChars = Math.floor(remaining / 2);
  const text = diff.slice(0, headChars) + marker + diff.slice(originalChars - tailChars);
  return { text, truncated: true, originalChars };
}

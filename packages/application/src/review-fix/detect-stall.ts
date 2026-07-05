export type StallType = 'none' | 'oscillation' | 'no_progress' | 'unfounded_pingpong';

/**
 * A single iteration's finding fingerprint + the fixer's verdict for that
 * iteration. Used by the new `detectUnfoundedPingPong` to short-circuit the
 * `review-fix` loop when the reviewer keeps re-emitting unfounded findings
 * while the fixer keeps rebutting.
 */
export interface FindingHistoryEntry {
  /** Normalized finding fingerprints (lowercased summaries). */
  readonly findings: ReadonlySet<string>;
  /** The fixer's verdict for this iteration. */
  readonly fixerVerdict?: 'done_with_fixes' | 'done_no_fixes_needed' | 'cannot_fix';
}

/**
 * Existing 3-iteration stall detector. Returns `oscillation` /
 * `no_progress` / `none`. Unchanged from pre-#623 behavior; kept here so
 * `review-fix-loop.ts` can call both this and `detectUnfoundedPingPong`
 * from one module.
 */
export function detectStall(findingHistory: Array<Set<string>>): StallType {
  if (findingHistory.length < 3) return 'none';

  const current = findingHistory[findingHistory.length - 1]!;
  const prev = findingHistory[findingHistory.length - 2]!;
  const prevPrev = findingHistory[findingHistory.length - 3]!;

  let hasOscillation = false;

  for (const finding of current) {
    if (prev.has(finding) && prevPrev.has(finding)) return 'no_progress';
    if (!prev.has(finding) && prevPrev.has(finding)) hasOscillation = true;
  }

  return hasOscillation ? 'oscillation' : 'none';
}

/**
 * Detect a ping-pong of *unfounded* findings: the reviewer keeps emitting
 * the same set of findings while the fixer keeps returning
 * `done_no_fixes_needed`. Returns `true` when the last `windowSize`
 * iterations all (a) had at least one finding and (b) the fixer rebutted
 * every one of them. The caller compares this with the unfounded count to
 * decide whether to short-circuit to `needs_human_review`.
 *
 * Default `windowSize` is 4 — chosen per design §4.4 to exceed the
 * existing `detectStall` 3-iteration horizon so the new signal takes
 * precedence on shorter cycles.
 */
export function detectUnfoundedPingPong(
  history: readonly FindingHistoryEntry[],
  windowSize = 4,
): boolean {
  if (history.length < windowSize) return false;
  const window = history.slice(history.length - windowSize);
  return window.every((e) => e.findings.size > 0 && e.fixerVerdict === 'done_no_fixes_needed');
}

/**
 * Build a normalized fingerprint set for a finding list. Lowercase + trim,
 * matching the pre-#623 normalization in `review-fix-loop.ts` lines 137-139.
 */
export function fingerprintFindings(
  findings: ReadonlyArray<{ severity: string; summary: string }>,
): Set<string> {
  return new Set(findings.map((f) => (f.summary ?? '').trim().toLowerCase()));
}

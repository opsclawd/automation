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

  const allRebutted = window.every(
    (e) => e.findings.size > 0 && e.fixerVerdict === 'done_no_fixes_needed',
  );
  if (!allRebutted) return false;

  const first = window[0]!.findings;
  for (const finding of first) {
    if (window.every((e) => e.findings.has(finding))) {
      return true;
    }
  }

  return false;
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

export interface TrendDetectionOptions {
  window?: number;
  mode?: 'strict' | 'lenient';
  lastRevalidationPassed?: boolean;
}

export interface TrendDetectionResult {
  converging: boolean;
  severityWeighted: number[];
}

const SEVERITY_MULTIPLIER: Record<string, number> = {
  critical: 4,
  high: 2,
  medium: 1,
  low: 0.5,
};

export function detectConvergingTrend(
  history: ReadonlyArray<{
    review?: { offendingFindings?: ReadonlyArray<{ severity: string }> };
    fix?: { verdict?: 'done_with_fixes' | 'done_no_fixes_needed' | 'cannot_fix' };
    revalidation?: { passed: boolean };
    outcome: 'resolved' | 'fixed' | 'unresolved' | 'failed';
  }>,
  opts: TrendDetectionOptions = {},
): TrendDetectionResult {
  const window = Math.max(2, opts.window ?? 3);
  const mode = opts.mode ?? 'strict';
  const fixHistory = history.filter((h) => h.review !== undefined);
  if (fixHistory.length < window) {
    return { converging: false, severityWeighted: [] };
  }
  const lateWindow = fixHistory.slice(-window);

  const severityWeighted = lateWindow.map((entry) => {
    const findings = entry.review?.offendingFindings ?? [];
    return findings.reduce((acc, f) => {
      const m = SEVERITY_MULTIPLIER[f.severity.trim().toLowerCase()] ?? 0;
      return acc + m;
    }, 0);
  });

  let nonIncreasing = true;
  for (let i = 1; i < severityWeighted.length; i += 1) {
    if (severityWeighted[i]! > severityWeighted[i - 1]!) {
      nonIncreasing = false;
      break;
    }
  }

  const lastIsLessThanFirst = severityWeighted[severityWeighted.length - 1]! < severityWeighted[0]!;

  const baseStrict = nonIncreasing && lastIsLessThanFirst;
  const converging =
    mode === 'strict' ? baseStrict && (opts.lastRevalidationPassed ?? false) : baseStrict;

  return { converging, severityWeighted };
}

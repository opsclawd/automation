export interface FixDiffInspectorInput {
  /** Worktree CWD where `git diff` runs. */
  readonly cwd: string;
  /**
   * SHA the comment was issued against. The shift-translator walks
   * hunks from this SHA to `runningStartSha` to translate `line`.
   */
  readonly originalStartCommitSha: string;
  /**
   * The current pre-task SHA in this poll. May equal
   * `originalStartCommitSha` for the first task; advances between tasks.
   */
  readonly runningStartSha: string;
  /** Head SHA of the agent's fix commit. */
  readonly fixCommitSha: string;
  /** Repo-relative path the comment was filed against. */
  readonly path: string;
  /** Original GitHub line number on the comment. */
  readonly line: number;
  /** Proximity window in lines. Default 5 in the adapter. */
  readonly proximityWindow?: number;
}

export interface FixDiffInspectionResult {
  /** True iff at least one diff hunk matches `path` under `+++ b/...`. */
  readonly touchesPath: boolean;
  /**
   * True iff at least one changed/add/deleted line in the matching
   * hunk(s) lies within `±proximityWindow` of (the translated)
   * `comment.line`. The literal `'skipped'` is returned when the
   * orchestrator passed `runningStartSha` strictly greater than
   * `originalStartCommitSha` and translation through the accumulated
   * diff failed (pathologically ambiguous or unparseable diff). When
   * `skipped`, the verifier continues to the LLM pass instead of
   * short-circuiting.
   */
  readonly nearLine: boolean | 'skipped';
  /**
   * Human-readable detail. For `touchesPath: false` this names the
   * file the fix *did* touch. For `nearLine: false` it states the
   * observed line range. For `'skipped'` it states why translation
   * was skipped.
   */
  readonly reason: string;
}

/**
 * Cheap, non-LLM structural cross-check. Runs before any
 * `verifyCodeChange` LLM pass and short-circuits on `nearLine: false`.
 * `touchesPath: false` is advisory only — cross-file fixes are
 * legitimate (#629), so the caller falls through to the LLM pass
 * (whose prompt carries the full fix diff) instead of rejecting.
 *
 * Implementation contract:
 *  - Always runs the file-touched check.
 *  - Always runs the line-proximity check against the SHIFTED line when
 *    a translation can be computed.
 *  - Returns `nearLine: 'skipped'` (never false) when the baseline
 *    advanced and translation is unavailable.
 *  - Never throws on a malformed diff; returns `nearLine: 'skipped'`
 *    with a `reason` that explains the fallback.
 */
export type FixDiffInspectorPort = (
  input: FixDiffInspectorInput,
) => Promise<FixDiffInspectionResult>;

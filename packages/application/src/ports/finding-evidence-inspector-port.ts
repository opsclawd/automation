export interface FindingEvidence {
  /** Repo-relative path referenced by the finding. */
  readonly path: string;
  /** Optional 1-based line number. */
  readonly line?: number;
  /**
   * Optional normalized snippet quote extracted from `code-review.md`.
   * Whitespace and comments are normalized before comparison.
   */
  readonly snippet?: string;
}

export interface FindingEvidenceCheckInput {
  /** Worktree CWD where `git show` runs. */
  readonly cwd: string;
  /** SHA or branch to inspect (e.g. current iteration head). */
  readonly ref: string;
  /** Evidence extracted from the reviewer's prose artifact. */
  readonly evidence: FindingEvidence;
}

export interface FindingEvidenceCheckResult {
  /**
   * True iff (path exists at `ref`) AND
   * (no evidence required OR evidence matches). Specifically:
   *   - `path` must exist at `ref` (tracked file, not deleted).
   *   - If `line` is set, it must be within the file's line range at `ref`.
   *   - If `snippet` is set, a normalized form must appear in the file at `ref`.
   * Returns `false` for any check failure (never throws on malformed input).
   */
  readonly evidenceConfirmed: boolean;
  /** Human-readable reason: ok / file missing / line out of range / snippet missing / etc. */
  readonly reason: string;
}

/**
 * Cheap, non-LLM structural cross-check. Mirrors the `FixDiffInspectorPort`
 * shape from #622. Used by the `review-fix` loop to detect reviewer
 * hallucinations before counting an iteration as `unresolved`.
 *
 * Implementation contract:
 *  - Never throws on malformed input; returns `evidenceConfirmed: false`
 *    with a descriptive `reason`.
 *  - Always performs the file-existence check first.
 *  - When `snippet` is set, normalizes whitespace before comparison.
 */
export type FindingEvidenceInspectorPort = (
  input: FindingEvidenceCheckInput,
) => Promise<FindingEvidenceCheckResult>;

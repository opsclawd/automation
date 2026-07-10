/**
 * Structured finding produced by the plan-review reviewer, parsed from
 * `plan-review-findings.md`. Each finding MUST have a `citation` (path:line
 * or section anchor) and a `failureScenario` (one-sentence defect
 * description) for P0/P1 severity. `evidence` reflects whether the citation
 * resolved against the artifact store (#716, AC #3).
 *
 * Defined here (alongside `EvidenceResolver`) so the port file has no
 * dependency on `types.ts` — avoids a circular import where
 * `types.ts` re-exports `EvidenceResolver`.
 */
export interface PlanReviewFinding {
  severity: 'P0' | 'P1' | 'P2';
  /** Required: path:line OR section-anchor reference (e.g. `plan.md:42`). */
  citation: string;
  /** Required: one-sentence failure scenario. */
  failureScenario: string;
  /**
   * Whether the citation resolved against the artifact store at parse time.
   * Ungrounded P0/P1 findings cannot contribute to a `p1_found` verdict.
   */
  evidence: 'grounded' | 'ungrounded';
  /**
   * Current disposition of this finding in the loop, if carried forward
   * from a prior iteration.
   */
  disposition?: 'addressed' | 'rebutted' | 'still_open' | 'never_seen_again';
}

/**
 * Port for resolving plan-review citations against the actual artifact
 * store (#716, design §2.3 / §3.6). Injected by the composition root
 * (`apps/api/src/compose.ts`) which has access to `ArtifactStore`.
 *
 * The application layer stays pure: the resolver is a function type, not a
 * Node-fs import. Tests inject an in-memory resolver; production binds it
 * to the artifact store backed by the run's worktree.
 *
 * Return `true` if the citation resolves, `false` otherwise. Citations that
 * resolve are marked `evidence: 'grounded'`; unresolvable citations are
 * `evidence: 'ungrounded'` and cannot contribute to a `p1_found` verdict.
 */
export type EvidenceResolver = (finding: PlanReviewFinding) => Promise<boolean>;

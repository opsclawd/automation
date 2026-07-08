/**
 * Single source of truth for "which agent profile arbitrates".
 *
 * Resolution order (operator-visible behavior, do not reorder):
 * dedicated `arbiter` key -> `plan-design` fallback -> `fix-review`
 * fallback -> undefined.
 *
 * The legacy `arbitrate` alias (previously chained as
 * `phaseProfiles['arbitrate']?.profile`) was retired in the #676
 * rename: the router's adapter-level fallback lookup keys on the
 * invocation's `phaseId` (which is the literal string `'arbiter'`,
 * see compose.ts:2762), so primary and fallback resolution can no
 * longer disagree on the key. See
 * docs/solutions/orchestrator/arbiter-wiring-2026-07-06.md for the
 * post-retirement history.
 *
 * This is the single resolution site: both `compose.ts` and the
 * plan-review loop's arbiter (#666) must import and call this function
 * rather than re-deriving the chain inline.
 */
export function resolveArbiterProfileName(
  phaseProfiles: Readonly<Record<string, { profile?: string | undefined } | undefined>>,
): string | undefined {
  return (
    phaseProfiles['arbiter']?.profile ??
    phaseProfiles['plan-design']?.profile ??
    phaseProfiles['fix-review']?.profile
  );
}

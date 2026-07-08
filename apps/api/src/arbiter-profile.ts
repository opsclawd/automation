/**
 * Single source of truth for "which agent profile arbitrates".
 *
 * Resolution order (operator-visible behavior, do not reorder):
 * dedicated `arbiter` key -> legacy `arbitrate` alias -> `plan-design`
 * fallback -> `fix-review` fallback -> undefined.
 *
 * The `arbitrate` alias exists because real operator configs already
 * declare `phaseProfiles['arbitrate']` (legacy name, historically
 * `role: planner`). See docs/solutions/orchestrator/arbiter-wiring-2026-07-06.md
 * for the history of this resolution.
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
    phaseProfiles['arbitrate']?.profile ??
    phaseProfiles['plan-design']?.profile ??
    phaseProfiles['fix-review']?.profile
  );
}

/**
 * Single source of truth for "which agent profile plans the fix".
 *
 * Resolution order (operator-visible behavior, do not reorder):
 * dedicated `fix-review-architect` key -> `roles.planner` fallback ->
 * `phaseProfiles['plan-design']` fallback -> undefined.
 *
 * The architect role is the same as the planner role; the dedicated
 * `fix-review-architect` key exists so operators can route the
 * architect to a slower/more expensive model without changing
 * `plan-design`'s profile. See design.md#d1 (Issue #668) for the
 * rationale.
 *
 * This is the single resolution site: only `compose.ts` calls this
 * function. Do not re-derive the chain inline.
 */
export function resolveArchitectProfileName(
  phaseProfiles: Readonly<Record<string, { profile?: string | undefined } | undefined>>,
  roles: Readonly<Record<string, { profile?: string | undefined } | undefined>>,
): string | undefined {
  return (
    phaseProfiles['fix-review-architect']?.profile ??
    roles['planner']?.profile ??
    phaseProfiles['plan-design']?.profile
  );
}

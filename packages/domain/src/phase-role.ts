/**
 * Canonical phase roles in the SDLC orchestration pipeline.
 *
 * Each agent phase handler in the orchestrator wires in a role-specific
 * profile variant (e.g. plannerProfile, reviewerProfile, fixProfile).
 * When runtime pinning is active, the pinned runtime resolves each of these
 * roles to that runtime's corresponding profile variant.
 *
 * See issues #1229 and #1231.
 */
export const PHASE_ROLES = [
  'planner',
  'implementer',
  'fixer',
  'critic',
  'pr-reviewer',
  'task-agent',
] as const;

export type PhaseRole = (typeof PHASE_ROLES)[number];

export function isPhaseRole(value: unknown): value is PhaseRole {
  return typeof value === 'string' && (PHASE_ROLES as readonly string[]).includes(value);
}

/**
 * Maps each known orchestrator phase name to its canonical PhaseRole.
 * Used during profile resolution when a phase handler requests a profile
 * under a pinned runtime.
 */
export const DEFAULT_PHASE_TO_ROLE: Readonly<Record<string, PhaseRole>> = Object.freeze({
  'plan-design': 'planner',
  'architecture-review': 'pr-reviewer',
  'architecture-fix': 'planner',
  implement: 'implementer',
  'quality-review': 'critic',
  'spec-review': 'critic',
  'post-implementation-spec-review': 'critic',
  'post-implementation-quality-review': 'critic',
  'follow-up-review': 'critic',
  'fix-review': 'fixer',
  'fix-validate': 'fixer',
  'whole-pr-fix-review': 'fixer',
  compound: 'task-agent',
  'create-pr': 'task-agent',
  'result-writer': 'critic',
});

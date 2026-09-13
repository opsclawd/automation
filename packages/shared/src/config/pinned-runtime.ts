import type { AgentConfig } from './schema.js';
import { resolvePhaseProfileEntry, PHASE_FALLBACKS } from './phase-fallbacks.js';

export type PinnedRuntimeName = 'claude-code' | 'antigravity' | 'codex' | 'opencode';

export const PINNED_RUNTIME_NAMES: readonly PinnedRuntimeName[] = Object.freeze([
  'claude-code',
  'antigravity',
  'codex',
  'opencode',
]);

export type PhaseRoleName =
  | 'planner'
  | 'implementer'
  | 'fixer'
  | 'critic'
  | 'pr-reviewer'
  | 'task-agent';

export const PHASE_ROLE_NAMES: readonly PhaseRoleName[] = Object.freeze([
  'planner',
  'implementer',
  'fixer',
  'critic',
  'pr-reviewer',
  'task-agent',
]);

export class PinnedRuntimeResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PinnedRuntimeResolutionError';
  }
}

/**
 * Built-in default phase-to-role mapping used when resolving phase roles for pinned runtimes.
 */
export const DEFAULT_PHASE_ROLE_MAPPING: Readonly<Record<string, PhaseRoleName>> = Object.freeze({
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

/**
 * Built-in default mapping from each of the four known runtimes to that runtime's
 * profile variant for every phase role currently in use.
 *
 * All referenced profiles exist in baseline orchestrator configuration and have
 * matching runtime identities.
 */
export const DEFAULT_PINNED_RUNTIME_PROFILES: Readonly<
  Record<PinnedRuntimeName, Readonly<Record<PhaseRoleName, string>>>
> = Object.freeze({
  'claude-code': Object.freeze({
    planner: 'claude',
    'pr-reviewer': 'claude',
    implementer: 'claude-sonnet',
    fixer: 'claude-sonnet',
    critic: 'claude-sonnet',
    'task-agent': 'claude-haiku',
  }),
  antigravity: Object.freeze({
    planner: 'gemini',
    'pr-reviewer': 'reviewer',
    implementer: 'gemini',
    fixer: 'gemini',
    critic: 'task-reviewer',
    'task-agent': 'task-reviewer',
  }),
  codex: Object.freeze({
    planner: 'codex-writer',
    'pr-reviewer': 'codex-reviewer',
    implementer: 'codex-writer',
    fixer: 'codex-writer',
    critic: 'codex-reviewer',
    'task-agent': 'codex-writer',
  }),
  opencode: Object.freeze({
    planner: 'architect',
    'pr-reviewer': 'senior',
    implementer: 'qwen',
    fixer: 'builder',
    critic: 'junior',
    'task-agent': 'junior',
  }),
});

export interface ResolvePinnedProfileOpts {
  pinnedRuntime: PinnedRuntimeName | string;
  role: PhaseRoleName | string;
  config: AgentConfig;
}

/**
 * Resolves the profile name for a given phase role under a pinned runtime.
 *
 * Lookup order:
 * 1. Explicit repository configuration in `agent.pinnedRuntimeProfiles[pinnedRuntime][role]`
 * 2. Built-in `DEFAULT_PINNED_RUNTIME_PROFILES[pinnedRuntime][role]`
 *
 * Fallback policy:
 * - If no mapping is defined: throws `PinnedRuntimeResolutionError` (fails loudly).
 * - If the resolved profile name is not found in `agent.profiles`: throws `PinnedRuntimeResolutionError` (fails loudly).
 * - If the resolved profile has a runtime mismatch: throws `PinnedRuntimeResolutionError` (fails loudly).
 */
export function resolvePinnedProfile(opts: ResolvePinnedProfileOpts): string {
  const { pinnedRuntime, role, config } = opts;

  let profileName = config.pinnedRuntimeProfiles?.[pinnedRuntime]?.[role];

  if (!profileName) {
    const runtimeDefaults = DEFAULT_PINNED_RUNTIME_PROFILES[pinnedRuntime as PinnedRuntimeName];
    if (runtimeDefaults) {
      profileName = runtimeDefaults[role as PhaseRoleName];
    }
  }

  if (!profileName) {
    throw new PinnedRuntimeResolutionError(
      `Pinned runtime '${pinnedRuntime}' has no mapped profile for role '${role}'.`,
    );
  }

  // Graceful fallback for claude-code: if claude-sonnet/claude-haiku are default but repo only defines 'claude', use 'claude'
  if (
    !config.profiles[profileName] &&
    pinnedRuntime === 'claude-code' &&
    config.profiles['claude']
  ) {
    profileName = 'claude';
  }

  const profile = config.profiles[profileName];
  if (!profile) {
    throw new PinnedRuntimeResolutionError(
      `Pinned runtime '${pinnedRuntime}' maps role '${role}' to profile '${profileName}', but profile '${profileName}' is not defined in agent.profiles.`,
    );
  }

  if (profile.runtime !== pinnedRuntime) {
    throw new PinnedRuntimeResolutionError(
      `Pinned runtime '${pinnedRuntime}' mapped role '${role}' to profile '${profileName}', but that profile has runtime '${profile.runtime}'.`,
    );
  }

  return profileName;
}

export interface ResolvePinnedProfileForPhaseOpts {
  pinnedRuntime: PinnedRuntimeName | string;
  phaseName: string;
  config: AgentConfig;
}

/**
 * Resolves the profile name for an orchestrator phase under a pinned runtime.
 * First resolves the phase's role, then delegates to `resolvePinnedProfile`.
 */
export function resolvePinnedProfileForPhase(opts: ResolvePinnedProfileForPhaseOpts): string {
  const { pinnedRuntime, phaseName, config } = opts;

  let role: string | undefined;
  const entry = resolvePhaseProfileEntry(config.phaseProfiles, phaseName);
  if (entry?.role) {
    role = entry.role;
  } else if (PHASE_FALLBACKS[phaseName] && config.phaseProfiles[PHASE_FALLBACKS[phaseName]]?.role) {
    role = config.phaseProfiles[PHASE_FALLBACKS[phaseName]]!.role;
  } else {
    role = DEFAULT_PHASE_ROLE_MAPPING[phaseName];
  }

  if (!role && PHASE_FALLBACKS[phaseName]) {
    role = DEFAULT_PHASE_ROLE_MAPPING[PHASE_FALLBACKS[phaseName]];
  }

  if (!role) {
    throw new PinnedRuntimeResolutionError(
      `Pinned runtime '${pinnedRuntime}' cannot resolve phase '${phaseName}': phase has no configured or default role.`,
    );
  }

  return resolvePinnedProfile({ pinnedRuntime, role, config });
}

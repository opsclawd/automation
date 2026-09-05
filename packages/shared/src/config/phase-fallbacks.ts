import type { AgentConfig } from './schema.js';

export const PHASE_FALLBACKS: Readonly<Record<string, string>> = Object.freeze({
  'whole-pr-fix-review': 'fix-review',
  'verify-pr-review': 'post-pr-review',
});

/**
 * `post-implementation-spec-review`/`post-implementation-quality-review` were
 * split into `spec-review`/`quality-review` (#1135). Unlike `PHASE_FALLBACKS`
 * above (bare key first, alias consulted only when the bare key is absent),
 * these two phases need the OPPOSITE precedence: the legacy key stays
 * authoritative when present, since existing `.ai-orchestrator.local.json`
 * files configure roles/fallbacks under the pre-split name, and base config
 * also defines an unrelated default under the bare name that must not
 * silently shadow it.
 *
 * Both the primary-profile resolution (apps/api/src/compose.ts) and the
 * on-failure fallback-profile resolution (agent-runtime-router.ts) MUST use
 * `resolvePhaseProfileEntry` below rather than indexing `phaseProfiles`
 * directly, or a fallback configured under the legacy key silently never
 * engages: the primary invocation resolves via the legacy key (finding the
 * intended profile), but a naive fallback lookup keyed on the bare runtime
 * phase id finds a *different*, unrelated phaseProfiles entry instead.
 */
export const LEGACY_PHASE_PROFILE_PREFERENCE: Readonly<Record<string, string>> = Object.freeze({
  'quality-review': 'post-implementation-quality-review',
  'spec-review': 'post-implementation-spec-review',
});

export function resolvePhaseProfileEntry(
  phaseProfiles: AgentConfig['phaseProfiles'],
  phaseId: string,
): AgentConfig['phaseProfiles'][string] | undefined {
  const legacyKey = LEGACY_PHASE_PROFILE_PREFERENCE[phaseId];
  if (legacyKey) {
    const legacyEntry = phaseProfiles[legacyKey];
    if (legacyEntry) return legacyEntry;
  }
  return phaseProfiles[phaseId];
}

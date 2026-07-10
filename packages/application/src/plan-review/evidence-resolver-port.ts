import type { EvidenceResolver } from './types.js';

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
export type { EvidenceResolver };

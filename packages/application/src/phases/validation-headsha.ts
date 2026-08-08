import type { PhaseHandlerContext } from './handler.js';

export const VALIDATION_HEADSHA_ARTIFACT = 'validation.headsha';

/**
 * Record the commit that validation last passed against.
 *
 * `create-pr` refuses to open a PR unless this matches HEAD, so every phase
 * that establishes "validation passed at this commit" must write it — not just
 * `validate`. When only `validate` wrote it, a run whose validation deferred to
 * `fix-validate` never produced one at all, and `create-pr` blocked on
 * `(missing)` even though the pipeline had converged.
 */
export async function recordValidationHeadSha(
  ctx: PhaseHandlerContext,
  phaseId: string,
): Promise<void> {
  try {
    const currentSha = await ctx.git.headCommitSha(ctx.cwd);
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId,
      relativePath: VALIDATION_HEADSHA_ARTIFACT,
      contents: `${currentSha.trim()}\n`,
    });
  } catch {
    // Non-fatal: a missing head sha degrades to create-pr re-validating.
  }
}

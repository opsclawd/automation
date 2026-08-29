import { createHash } from 'node:crypto';
import type { PhaseHandlerContext } from './handler.js';
import type { GitPort } from '../ports/git-port.js';
import {
  parseGitStatusLine,
  isOrchestratorArtifactPattern,
} from '../artifacts/orchestrator-artifacts.js';

export const VALIDATION_RESULT_ARTIFACT = 'validation.result';
export const VALIDATION_HEADSHA_ARTIFACT = 'validation.headsha';
export const VALIDATION_FINGERPRINT_ARTIFACT = 'validation.fingerprint';

/**
 * Computes a deterministic SHA-256 fingerprint of the current worktree source state.
 *
 * The source state fingerprint accounts for:
 * 1. HEAD commit SHA
 * 2. Uncommitted source changes (status lines for dirty/untracked files, ignoring orchestrator artifacts)
 *
 * This ensures that even uncommitted changes in the lean pipeline (#1103) have a precise identity.
 */
export async function computeWorktreeSourceFingerprint(ctx: {
  git: GitPort;
  cwd: string;
}): Promise<string> {
  let headSha = '';
  try {
    headSha = (await ctx.git.headCommitSha(ctx.cwd)).trim();
  } catch {
    headSha = '';
  }

  let rawStatus = '';
  try {
    rawStatus = await ctx.git.status(ctx.cwd);
  } catch {
    rawStatus = '';
  }

  const sourceLines: string[] = [];
  const statusLines = rawStatus.split('\n').filter(Boolean);

  for (const line of statusLines) {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed || trimmed.length < 3) continue;
    const paths = parseGitStatusLine(trimmed);
    const hasSourcePath = paths.some((p) => !isOrchestratorArtifactPattern(p));
    if (hasSourcePath) {
      sourceLines.push(trimmed);
    }
  }

  sourceLines.sort();
  const payload = `${headSha}\n${sourceLines.join('\n')}`;
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Record full deterministic validation evidence (result, headsha, fingerprint).
 */
export async function recordValidationEvidence(
  ctx: PhaseHandlerContext,
  phaseId: string,
): Promise<void> {
  try {
    const currentSha = (await ctx.git.headCommitSha(ctx.cwd)).trim();
    const fingerprint = await computeWorktreeSourceFingerprint(ctx);

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId,
      relativePath: VALIDATION_HEADSHA_ARTIFACT,
      contents: `${currentSha}\n`,
    });

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId,
      relativePath: VALIDATION_RESULT_ARTIFACT,
      contents: 'passed\n',
    });

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId,
      relativePath: VALIDATION_FINGERPRINT_ARTIFACT,
      contents: `${fingerprint}\n`,
    });
  } catch {
    // Non-fatal: a missing validation evidence artifact degrades to review/PR gates re-validating.
  }
}

/**
 * Legacy compatibility alias for recordValidationEvidence.
 */
export async function recordValidationHeadSha(
  ctx: PhaseHandlerContext,
  phaseId: string,
): Promise<void> {
  return recordValidationEvidence(ctx, phaseId);
}

/**
 * Invalidate prior validation evidence after a mutation phase (e.g. fix-review).
 */
export async function invalidateValidationEvidence(
  ctx: PhaseHandlerContext,
  phaseId: string,
): Promise<void> {
  try {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId,
      relativePath: VALIDATION_RESULT_ARTIFACT,
      contents: 'invalidated\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId,
      relativePath: VALIDATION_FINGERPRINT_ARTIFACT,
      contents: '',
    });
  } catch {
    // Best-effort
  }
}

export interface ValidationFreshnessResult {
  fresh: boolean;
  reason?: string;
  expectedFingerprint?: string;
  currentFingerprint?: string;
}

/**
 * Verify that deterministic validation has passed and corresponds to the current worktree state.
 */
export async function verifyValidationFreshness(
  ctx: PhaseHandlerContext,
): Promise<ValidationFreshnessResult> {
  let valResult: string;
  try {
    valResult = (await ctx.artifacts.read(ctx.runUuid, VALIDATION_RESULT_ARTIFACT)).trim();
  } catch {
    return {
      fresh: false,
      reason: 'Validation result artifact (validation.result) is missing',
    };
  }

  if (valResult !== 'passed') {
    return {
      fresh: false,
      reason: `Validation status is '${valResult || 'empty'}' (expected 'passed')`,
    };
  }

  let recordedFingerprint: string;
  try {
    recordedFingerprint = (
      await ctx.artifacts.read(ctx.runUuid, VALIDATION_FINGERPRINT_ARTIFACT)
    ).trim();
  } catch {
    return {
      fresh: false,
      reason: 'Validation fingerprint artifact (validation.fingerprint) is missing',
    };
  }

  if (!recordedFingerprint) {
    return {
      fresh: false,
      reason: 'Validation fingerprint is empty (invalidated or missing)',
    };
  }

  let currentFingerprint: string;
  try {
    currentFingerprint = await computeWorktreeSourceFingerprint(ctx);
  } catch (err) {
    return {
      fresh: false,
      reason: `Failed to inspect worktree state: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (currentFingerprint !== recordedFingerprint) {
    return {
      fresh: false,
      reason: `Validation evidence is stale: worktree source state modified since last validation (recorded: ${recordedFingerprint.slice(0, 8)}, current: ${currentFingerprint.slice(0, 8)})`,
      expectedFingerprint: recordedFingerprint,
      currentFingerprint,
    };
  }

  return {
    fresh: true,
    expectedFingerprint: recordedFingerprint,
    currentFingerprint,
  };
}

import { ArtifactNotFoundError, type ArtifactStore } from '@ai-sdlc/application';

/**
 * Phase-segregated archive names for per-step review/fix results. Every agent
 * invocation writes its verdict to the shared `result.json`, so later phases
 * overwrite earlier ones in the artifact store; the spec-review and fix
 * closures archive their result under these names so the arbiter can read
 * both sides of a contradiction (#661).
 */
export const SPEC_REVIEW_RESULT_ARTIFACT = 'spec-review-result.json';
export const QUALITY_REVIEW_RESULT_ARTIFACT = 'quality-review-result.json';
export const FIX_RESULT_ARTIFACT = 'fix-result.json';

const EXCERPT_MAX_CHARS = 4000;

async function readExcerpt(
  artifacts: ArtifactStore,
  runId: string,
  relativePath: string,
): Promise<string> {
  try {
    return (await artifacts.read(runId, relativePath)).slice(0, EXCERPT_MAX_CHARS);
  } catch (err) {
    if (!(err instanceof ArtifactNotFoundError)) throw err;
    return '';
  }
}

export async function readArbiterExcerpts(
  artifacts: ArtifactStore,
  runId: string,
): Promise<{ specExcerpt: string; qualityExcerpt: string; fixExcerpt: string }> {
  return {
    specExcerpt: await readExcerpt(artifacts, runId, SPEC_REVIEW_RESULT_ARTIFACT),
    qualityExcerpt: await readExcerpt(artifacts, runId, QUALITY_REVIEW_RESULT_ARTIFACT),
    fixExcerpt: await readExcerpt(artifacts, runId, FIX_RESULT_ARTIFACT),
  };
}

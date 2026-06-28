export const ORCHESTRATOR_ARTIFACT_PATHS = Object.freeze([
  'validation.headsha',
  'review-fix-plan.json',
  'review-task-manifest.json',
  'review-triage.md',
  'code-review.md',
  'review.md',
  'task-manifest.json',
  'arbiter-result.json',
  'review-loop-history.json',
  'compound-draft.md',
  'validation.result',
  'result.json',
  'fix-validate-done.marker',
  'plan-review-passed.marker',
] as const);

export const ORCHESTRATOR_PATCH_EXCLUDE = '*.patch';

export const orchestratorArtifactPathSet = new Set<string>(
  ORCHESTRATOR_ARTIFACT_PATHS,
) as ReadonlySet<string>;

export function isOrchestratorArtifactPath(path: string): boolean {
  return orchestratorArtifactPathSet.has(path);
}

export function orchestratorExcludePatterns(): readonly string[] {
  return Object.freeze([...ORCHESTRATOR_ARTIFACT_PATHS, ORCHESTRATOR_PATCH_EXCLUDE]);
}

export const ORCHESTRATOR_ARTIFACT_PATHS = Object.freeze([
  'validation.headsha',
  'review-fix-plan.json',
  'review-task-manifest.json',
  'review-triage.md',
  'code-review.md',
  'review.md',
  'task-manifest.json',
  'implementation-log.md',
  'arbiter-result.json',
  'review-loop-history.json',
  'implement-step-history-*.json',
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

export const PROMPT_ORCHESTRATOR_ARTIFACT_PATHS = Object.freeze([
  'issue.md',
  'issue-comments.md',
  'design.md',
  'plan.md',
  'task-context-step-*.md',
  'plan-review-findings.md',
  'plan-fix-result.json',
  'quality-review-result*.json',
  'spec-review-result*.json',
  'fix-result*.json',
  'prompt.md',
  'implementation-log*.md',
] as const);

export function getGitCommitExcludePathspecs(): readonly string[] {
  const allPatterns = [
    ...ORCHESTRATOR_ARTIFACT_PATHS,
    ORCHESTRATOR_PATCH_EXCLUDE,
    ...PROMPT_ORCHESTRATOR_ARTIFACT_PATHS,
  ];
  const unique = Array.from(new Set(allPatterns));
  return Object.freeze(unique.map((p) => `':!${p}'`));
}

export function getGitCommitExcludePathspecsString(): string {
  return getGitCommitExcludePathspecs().join(' ');
}

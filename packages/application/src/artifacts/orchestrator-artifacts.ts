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
  'compound.md',
  'validation.result',
  'result.json',
  'fix-validate-done.marker',
  'plan-review-passed.marker',
  'pr-summary.md',
  // create-pr writes this itself, then its own clean-worktree guard reads the
  // tree on resume — omitting it made create-pr block on its own output.
  'pr-url.txt',
] as const);

export const ORCHESTRATOR_PATCH_EXCLUDE = '*.patch';

export const ORCHESTRATOR_DIFF_EXCLUDES = Object.freeze([
  '*.diff',
  '*-diff.txt',
  'diff.txt',
] as const);

export const orchestratorArtifactPathSet = new Set<string>(
  ORCHESTRATOR_ARTIFACT_PATHS,
) as ReadonlySet<string>;

export function isOrchestratorArtifactPath(path: string): boolean {
  return orchestratorArtifactPathSet.has(path);
}

export function orchestratorExcludePatterns(): readonly string[] {
  return Object.freeze([
    ...ORCHESTRATOR_ARTIFACT_PATHS,
    ORCHESTRATOR_PATCH_EXCLUDE,
    ...ORCHESTRATOR_DIFF_EXCLUDES,
    ...PROMPT_ORCHESTRATOR_ARTIFACT_PATHS,
  ]);
}

function patternToRegExp(pattern: string): RegExp {
  const regexString =
    '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$';
  return new RegExp(regexString);
}

export function uncommittedSourcePaths(status: string): string[] {
  const patterns = orchestratorExcludePatterns();
  const compiledRegexes = patterns.map(patternToRegExp);
  const sourcePaths = status
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => (line.length > 3 ? line.slice(3).split(' -> ') : []))
    .map((path) => path.replace(/\\/g, '/'))
    .filter((path) => path.length > 0)
    .filter((path) => !compiledRegexes.some((regex) => regex.test(path)));

  return [...new Set(sourcePaths)].sort();
}

export function formatDirtyPaths(paths: readonly string[], max = 10): string {
  if (paths.length <= max) {
    return paths.join(', ');
  }
  const shown = paths.slice(0, max).join(', ');
  const remaining = paths.length - max;
  return `${shown} and ${remaining} more`;
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
  const allPatterns = orchestratorExcludePatterns();
  const unique = Array.from(new Set(allPatterns));
  return Object.freeze(unique.map((p) => `':!${p}'`));
}

export function getGitCommitExcludePathspecsString(): string {
  return getGitCommitExcludePathspecs().join(' ');
}

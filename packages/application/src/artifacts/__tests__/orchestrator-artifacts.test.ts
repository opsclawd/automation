import { describe, it, expect } from 'vitest';
import {
  ORCHESTRATOR_ARTIFACT_PATHS,
  ORCHESTRATOR_PATCH_EXCLUDE,
  PROMPT_ORCHESTRATOR_ARTIFACT_PATHS,
  orchestratorArtifactPathSet,
  isOrchestratorArtifactPath,
  orchestratorExcludePatterns,
  uncommittedSourcePaths,
} from '../orchestrator-artifacts.js';

describe('orchestrator-artifacts (parity with scripts/lib/artifacts.sh)', () => {
  it('should assert the exact canonical artifact list', () => {
    // This exact list is pinned to scripts/lib/artifacts.sh while bash parity exists.
    // Any change here must also be updated in scripts/lib/artifacts.sh.
    const expected = [
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
      'pr-summary.md',
    ];
    expect(ORCHESTRATOR_ARTIFACT_PATHS).toEqual(expected);
    expect(Object.isFrozen(ORCHESTRATOR_ARTIFACT_PATHS)).toBe(true);
  });

  it('should export ORCHESTRATOR_PATCH_EXCLUDE as *.patch', () => {
    expect(ORCHESTRATOR_PATCH_EXCLUDE).toBe('*.patch');
  });

  it('should have a path set containing all artifacts', () => {
    expect(orchestratorArtifactPathSet.size).toBe(ORCHESTRATOR_ARTIFACT_PATHS.length);
    for (const path of ORCHESTRATOR_ARTIFACT_PATHS) {
      expect(orchestratorArtifactPathSet.has(path)).toBe(true);
      expect(isOrchestratorArtifactPath(path)).toBe(true);
    }
    expect(isOrchestratorArtifactPath('non-existent-artifact.json')).toBe(false);
  });

  it('should return correct exclude patterns', () => {
    const patterns = orchestratorExcludePatterns();
    expect(patterns).toEqual([
      ...ORCHESTRATOR_ARTIFACT_PATHS,
      '*.patch',
      '*.diff',
      '*-diff.txt',
      'diff.txt',
      ...PROMPT_ORCHESTRATOR_ARTIFACT_PATHS,
    ]);
    expect(Object.isFrozen(patterns)).toBe(true);
  });
});

describe('uncommittedSourcePaths', () => {
  it('returns empty array when status is empty', () => {
    expect(uncommittedSourcePaths('')).toEqual([]);
  });

  it('filters out orchestrator artifacts, patch, and diff files at root', () => {
    const status = [
      ' M plan.md',
      '?? implementation-log-task-1.md',
      '?? changes.patch',
      ' M pr-summary.md',
      '?? fix.diff',
      ' M bar-diff.txt',
      '?? diff.txt',
    ].join('\n');
    expect(uncommittedSourcePaths(status)).toEqual([]);
  });

  it('preserves nested files even if they match root artifact names', () => {
    const status = [' M src/plan.md', '?? docs/changes.patch'].join('\n');
    expect(uncommittedSourcePaths(status)).toEqual(['docs/changes.patch', 'src/plan.md']);
  });

  it('handles renames, backslashes, duplicates and sorts the output', () => {
    const status = [
      'R  old\\path.ts -> new\\path.ts',
      ' M packages\\app.ts',
      ' M packages/app.ts',
    ].join('\n');
    expect(uncommittedSourcePaths(status)).toEqual([
      'new/path.ts',
      'old/path.ts',
      'packages/app.ts',
    ]);
  });
});

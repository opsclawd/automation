import { describe, it, expect } from 'vitest';
import {
  ORCHESTRATOR_ARTIFACT_PATHS,
  ORCHESTRATOR_PATCH_EXCLUDE,
  orchestratorArtifactPathSet,
  isOrchestratorArtifactPath,
  orchestratorExcludePatterns,
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
      'arbiter-result.json',
      'review-loop-history.json',
      'compound-draft.md',
      'validation.result',
      'result.json',
      'fix-validate-done.marker',
      'plan-review-passed.marker',
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
    expect(patterns).toEqual([...ORCHESTRATOR_ARTIFACT_PATHS, '*.patch']);
    expect(Object.isFrozen(patterns)).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import {
  ORCHESTRATOR_ARTIFACT_PATHS,
  ORCHESTRATOR_PATCH_EXCLUDE,
  PROMPT_ORCHESTRATOR_ARTIFACT_PATHS,
  orchestratorArtifactPathSet,
  isOrchestratorArtifactPath,
  isOrchestratorArtifactPattern,
  orchestratorExcludePatterns,
  parseGitStatusPaths,
  uncommittedSourcePaths,
  unquoteGitPath,
  formatDirtyPaths,
  isUntrackedOrAddedStatusLine,
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
      'compound.md',
      'validation.result',
      'result.json',
      'scratch-files.json',
      '.ai-tmp/scratch-files.json',
      'fix-validate-done.marker',
      'plan-review-passed.marker',
      'pr-summary.md',
      'pr-url.txt',
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

describe('parseGitStatusPaths', () => {
  it('returns empty array when status is empty', () => {
    expect(parseGitStatusPaths('')).toEqual([]);
  });

  it('parseGitStatusPaths returns every normalized path without artifact filtering', () => {
    const status = [
      ' M plan.md',
      '?? plan-review-findings.md',
      ' M src/nested/file.ts',
      ' M src\\nested/file.ts',
      '?? "src/quoted with space.ts"',
      'R  old.ts -> new.ts',
    ].join('\n');
    expect(parseGitStatusPaths(status)).toEqual([
      'new.ts',
      'old.ts',
      'plan-review-findings.md',
      'plan.md',
      'src/nested/file.ts',
      'src/quoted with space.ts',
    ]);
  });
});

describe('uncommittedSourcePaths', () => {
  it('uncommittedSourcePaths preserves global orchestrator artifact filtering', () => {
    const status = [
      ' M plan.md',
      '?? plan-review-findings.md',
      '?? implementation-log.md',
      ' M pr-summary.md',
      '?? pr-url.txt',
      '?? changes.patch',
      '?? fix.diff',
      ' M src/plan.md',
      '?? nested/design.md',
      'R  old.ts -> new.ts',
    ].join('\n');
    expect(uncommittedSourcePaths(status)).toEqual([
      'nested/design.md',
      'new.ts',
      'old.ts',
      'src/plan.md',
    ]);
  });

  it('returns empty array when status is empty', () => {
    expect(uncommittedSourcePaths('')).toEqual([]);
  });

  it('filters out orchestrator artifacts, patch, and diff files at root', () => {
    const status = [
      ' M plan.md',
      '?? implementation-log-task-1.md',
      '?? changes.patch',
      ' M pr-summary.md',
      '?? pr-url.txt',
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

  it('unquotes quoted git porcelain paths with spaces, escaped quotes, and escapes', () => {
    const status = [
      '?? "src/file with spaces.ts"',
      '?? "src/file\\"with\\"quotes.ts"',
      '?? "src/tab\\tfile.ts"',
      ' M "src/plan.md"',
      '?? "plan.md"',
    ].join('\n');
    expect(uncommittedSourcePaths(status)).toEqual([
      'src/file with spaces.ts',
      'src/file"with"quotes.ts',
      'src/plan.md',
      'src/tab\tfile.ts',
    ]);
  });
});

describe('unquoteGitPath', () => {
  it('returns unquoted string unchanged', () => {
    expect(unquoteGitPath('src/file.ts')).toBe('src/file.ts');
  });

  it('unquotes double-quoted paths', () => {
    expect(unquoteGitPath('"src/file with spaces.ts"')).toBe('src/file with spaces.ts');
  });

  it('handles escaped quotes and backslashes', () => {
    expect(unquoteGitPath('"src/foo\\"bar\\\\baz.ts"')).toBe('src/foo"bar\\baz.ts');
  });

  it('handles standard C-escapes', () => {
    expect(unquoteGitPath('"src/line\\nbreak.ts"')).toBe('src/line\nbreak.ts');
    expect(unquoteGitPath('"src/tab\\tfile.ts"')).toBe('src/tab\tfile.ts');
    expect(unquoteGitPath('"src/bell\\a.ts"')).toBe('src/bell\x07.ts');
  });

  it('handles octal escapes', () => {
    expect(unquoteGitPath('"src/\\040file.ts"')).toBe('src/ file.ts');
  });
});

describe('isOrchestratorArtifactPattern', () => {
  it('matches literal orchestrator artifact paths', () => {
    expect(isOrchestratorArtifactPattern('plan.md')).toBe(true);
    expect(isOrchestratorArtifactPattern('task-manifest.json')).toBe(true);
    expect(isOrchestratorArtifactPattern('result.json')).toBe(true);
    expect(isOrchestratorArtifactPattern('design.md')).toBe(true);
    expect(isOrchestratorArtifactPattern('issue.md')).toBe(true);
    expect(isOrchestratorArtifactPattern('issue-comments.md')).toBe(true);
    expect(isOrchestratorArtifactPattern('prompt.md')).toBe(true);
    expect(isOrchestratorArtifactPattern('pr-summary.md')).toBe(true);
    expect(isOrchestratorArtifactPattern('pr-url.txt')).toBe(true);
    expect(isOrchestratorArtifactPattern('.ai-tmp/scratch-files.json')).toBe(true);
  });

  it('matches glob-form orchestrator artifact paths', () => {
    expect(isOrchestratorArtifactPattern('implement-step-history-1.json')).toBe(true);
    expect(isOrchestratorArtifactPattern('task-context-step-3.md')).toBe(true);
    expect(isOrchestratorArtifactPattern('quality-review-result-1.json')).toBe(true);
    expect(isOrchestratorArtifactPattern('spec-review-result-2.json')).toBe(true);
    expect(isOrchestratorArtifactPattern('fix-result-1.json')).toBe(true);
    expect(isOrchestratorArtifactPattern('implementation-log-task-1.md')).toBe(true);
    expect(isOrchestratorArtifactPattern('foo.patch')).toBe(true);
    expect(isOrchestratorArtifactPattern('bar.diff')).toBe(true);
  });

  it('handles normalized leading slashes and dot-slash prefixes', () => {
    expect(isOrchestratorArtifactPattern('./plan.md')).toBe(true);
    expect(isOrchestratorArtifactPattern('/task-manifest.json')).toBe(true);
  });

  it('returns false for non-artifact paths and nested paths with artifact filenames', () => {
    expect(isOrchestratorArtifactPattern('src/index.ts')).toBe(false);
    expect(isOrchestratorArtifactPattern('test-ast.js')).toBe(false);
    expect(isOrchestratorArtifactPattern('src/plan.md')).toBe(false);
    expect(isOrchestratorArtifactPattern('nested/design.md')).toBe(false);
    expect(isOrchestratorArtifactPattern('')).toBe(false);
  });
});

describe('formatDirtyPaths', () => {
  it('returns empty string when given empty array', () => {
    expect(formatDirtyPaths([])).toBe('');
  });

  it('formats paths with comma-separated list when length is within default limit (10)', () => {
    const paths = ['a.ts', 'b.ts', 'c.ts'];
    expect(formatDirtyPaths(paths)).toBe('a.ts, b.ts, c.ts');
  });

  it('truncates paths list when length exceeds default limit of 10 and appends count', () => {
    const paths = Array.from({ length: 15 }, (_, i) => `file-${i + 1}.ts`);
    const expected =
      'file-1.ts, file-2.ts, file-3.ts, file-4.ts, file-5.ts, file-6.ts, file-7.ts, file-8.ts, file-9.ts, file-10.ts and 5 more';
    expect(formatDirtyPaths(paths)).toBe(expected);
  });

  it('supports custom limit parameter', () => {
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
    expect(formatDirtyPaths(paths, 2)).toBe('a.ts, b.ts and 2 more');
  });
});

describe('isUntrackedOrAddedStatusLine', () => {
  it('identifies untracked and staged new file indicators', () => {
    expect(isUntrackedOrAddedStatusLine('?? src/new.ts')).toBe(true);
    expect(isUntrackedOrAddedStatusLine('A  src/staged.ts')).toBe(true);
    expect(isUntrackedOrAddedStatusLine('AM src/staged-mod.ts')).toBe(true);
    expect(isUntrackedOrAddedStatusLine('AD src/staged-del.ts')).toBe(true);
    expect(isUntrackedOrAddedStatusLine(' A src/worktree-add.ts')).toBe(true);
    expect(isUntrackedOrAddedStatusLine('AA src/both-added.ts')).toBe(true);
    expect(isUntrackedOrAddedStatusLine('AU src/added-by-us.ts')).toBe(true);
    expect(isUntrackedOrAddedStatusLine('UA src/added-by-them.ts')).toBe(true);
  });

  it('rejects tracked modified, deleted, and rename indicators', () => {
    expect(isUntrackedOrAddedStatusLine(' M src/modified.ts')).toBe(false);
    expect(isUntrackedOrAddedStatusLine('M  src/staged-mod.ts')).toBe(false);
    expect(isUntrackedOrAddedStatusLine('MM src/both-mod.ts')).toBe(false);
    expect(isUntrackedOrAddedStatusLine(' D src/deleted.ts')).toBe(false);
    expect(isUntrackedOrAddedStatusLine('D  src/staged-del.ts')).toBe(false);
    expect(isUntrackedOrAddedStatusLine('R  src/old.ts -> src/new.ts')).toBe(false);
    expect(isUntrackedOrAddedStatusLine('RM src/old.ts -> src/new.ts')).toBe(false);
    expect(isUntrackedOrAddedStatusLine('')).toBe(false);
    expect(isUntrackedOrAddedStatusLine('??')).toBe(false);
  });
});

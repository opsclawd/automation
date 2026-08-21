import { describe, it, expect } from 'vitest';
import {
  classifyTaskChanges,
  normalizeTaskPath,
  type TaskScopeClassification,
  type TaskChangeCandidate,
  type EffectiveTaskScope,
} from '../task-file-boundaries.js';

describe('classifyTaskChanges', () => {
  // Invariant: classification-precedence
  it('classifies protected non-goal downstream reference exact area and drift candidates in precedence order', () => {
    const currentScope: EffectiveTaskScope = {
      requiredFiles: ['src/exact-req.ts'],
      mayExtendFiles: [
        'src/exact-opt.ts',
        '.gitignore', // collision: protected should win over mayExtend
        'src/blocked/file.ts', // collision: non-goal should win over mayExtend
        'src/downstream-file.ts', // collision: downstream should win over mayExtend
        'src/ref-file.ts', // collision: reference should win over mayExtend
      ],
      permittedAreas: ['src/area', 'src/blocked'],
      nonGoals: ['src/blocked'],
      referenceFiles: ['src/ref-file.ts'],
    };

    const manifestTasks = [
      {
        n: 1,
        expected_files: ['src/exact-req.ts'],
      },
      {
        n: 2,
        expected_files: ['src/downstream-file.ts'],
      },
    ];

    const candidates: TaskChangeCandidate[] = [
      { path: '.gitignore', tracked: true }, // 1. Protected
      { path: 'src/blocked/file.ts', tracked: true }, // 2. Non-goal
      { path: 'src/downstream-file.ts', tracked: true }, // 3. Downstream
      { path: 'src/ref-file.ts', tracked: true }, // 4. Reference
      { path: 'src/exact-req.ts', tracked: false }, // 5. Exact required (untracked ok)
      { path: 'src/exact-opt.ts', tracked: true }, // 5. Exact mayExtend
      { path: 'src/area/existing.ts', tracked: true }, // 6. Area (tracked)
      { path: 'src/area/new-drift.ts', tracked: false }, // 6. Area untracked -> 7. Drift
      { path: 'other/rogue.ts', tracked: true }, // 7. Drift
    ];

    const result: TaskScopeClassification = classifyTaskChanges({
      candidates,
      currentScope,
      manifestTasks,
      currentTaskNumber: 1,
    });

    expect(result.protectedFiles).toEqual(['.gitignore']);
    expect(result.nonGoalFiles).toEqual(['src/blocked/file.ts']);
    expect(result.prematureImplementation).toEqual([
      { path: 'src/downstream-file.ts', taskNumber: 2 },
    ]);
    expect(result.modifiedReferenceFiles).toEqual(['src/ref-file.ts']);
    expect(result.permittedPaths).toEqual([
      'src/area/existing.ts',
      'src/exact-opt.ts',
      'src/exact-req.ts',
    ]);
    expect(result.driftFiles).toEqual(['other/rogue.ts', 'src/area/new-drift.ts']);
  });

  // Invariant: downstream-ownership-wins
  it('downstream expected ownership overrides may_extend and permitted_areas and reports the owning task', () => {
    const currentScope: EffectiveTaskScope = {
      requiredFiles: ['src/task1.ts'],
      mayExtendFiles: ['src/shared-client.ts'],
      permittedAreas: ['src/components'],
      nonGoals: [],
      referenceFiles: [],
    };

    const manifestTasks = [
      { n: 1, expected_files: ['src/task1.ts'] },
      { n: 2, expected_files: ['src/shared-client.ts'] },
      { n: 3, expected_files: ['src/components/button.tsx'] },
    ];

    const candidates: TaskChangeCandidate[] = [
      { path: 'src/shared-client.ts', tracked: true }, // in mayExtendFiles, but in Task 2 expected_files
      { path: 'src/components/button.tsx', tracked: true }, // in permittedAreas, but in Task 3 expected_files
      { path: 'src/task1.ts', tracked: true }, // current task required
    ];

    const result = classifyTaskChanges({
      candidates,
      currentScope,
      manifestTasks,
      currentTaskNumber: 1,
    });

    expect(result.prematureImplementation).toEqual([
      { path: 'src/components/button.tsx', taskNumber: 3 },
      { path: 'src/shared-client.ts', taskNumber: 2 },
    ]);
    expect(result.permittedPaths).toEqual(['src/task1.ts']);
    expect(result.driftFiles).toEqual([]);
    expect(result.nonGoalFiles).toEqual([]);
    expect(result.modifiedReferenceFiles).toEqual([]);
  });

  // Invariant: non-goal-wins
  it('non_goals override exact and area permission', () => {
    const currentScope: EffectiveTaskScope = {
      requiredFiles: ['src/core/blocked-direct.ts'],
      mayExtendFiles: ['src/core/blocked-opt.ts'],
      permittedAreas: ['src/core'],
      nonGoals: ['src/core/blocked-direct.ts', 'src/core/blocked-opt.ts', 'src/core/legacy-dir'],
      referenceFiles: [],
    };

    const candidates: TaskChangeCandidate[] = [
      { path: 'src/core/blocked-direct.ts', tracked: true },
      { path: 'src/core/blocked-opt.ts', tracked: true },
      { path: 'src/core/legacy-dir/old.ts', tracked: true },
      { path: 'src/core/allowed.ts', tracked: true },
    ];

    const result = classifyTaskChanges({
      candidates,
      currentScope,
    });

    expect(result.nonGoalFiles).toEqual([
      'src/core/blocked-direct.ts',
      'src/core/blocked-opt.ts',
      'src/core/legacy-dir/old.ts',
    ]);
    expect(result.permittedPaths).toEqual(['src/core/allowed.ts']);
    expect(result.driftFiles).toEqual([]);
  });

  // Invariant: reference-wins
  it('reference_files remain read-only under contradictory legacy permission', () => {
    const currentScope: EffectiveTaskScope = {
      requiredFiles: [],
      mayExtendFiles: ['src/ref-opt.ts'],
      permittedAreas: ['src/refs'],
      nonGoals: [],
      referenceFiles: ['src/ref-opt.ts', 'src/refs/doc.md'],
    };

    const candidates: TaskChangeCandidate[] = [
      { path: 'src/ref-opt.ts', tracked: true },
      { path: 'src/refs/doc.md', tracked: true },
      { path: 'src/refs/other.ts', tracked: true },
    ];

    const result = classifyTaskChanges({
      candidates,
      currentScope,
    });

    expect(result.modifiedReferenceFiles).toEqual(['src/ref-opt.ts', 'src/refs/doc.md']);
    expect(result.permittedPaths).toEqual(['src/refs/other.ts']);
  });

  // Invariant: area-tracked-only
  it('permits tracked area edits but classifies area-only untracked creations as drift', () => {
    const currentScope: EffectiveTaskScope = {
      requiredFiles: ['src/new-required.ts'],
      mayExtendFiles: ['src/new-optional.ts'],
      permittedAreas: ['src/area'],
      nonGoals: [],
      referenceFiles: [],
    };

    const candidates: TaskChangeCandidate[] = [
      { path: 'src/area/existing.ts', tracked: true }, // tracked area -> permitted
      { path: 'src/area/new-file.ts', tracked: false }, // untracked area -> drift
      { path: 'src/new-required.ts', tracked: false }, // untracked exact required -> permitted
      { path: 'src/new-optional.ts', tracked: false }, // untracked exact optional -> permitted
    ];

    const result = classifyTaskChanges({
      candidates,
      currentScope,
    });

    expect(result.permittedPaths).toEqual([
      'src/area/existing.ts',
      'src/new-optional.ts',
      'src/new-required.ts',
    ]);
    expect(result.driftFiles).toEqual(['src/area/new-file.ts']);
  });

  // Invariant: segment-aware-matching
  it('does not match string-prefix sibling paths', () => {
    const currentScope: EffectiveTaskScope = {
      requiredFiles: [],
      mayExtendFiles: [],
      permittedAreas: ['packages/app'],
      nonGoals: ['packages/lib'],
      referenceFiles: ['packages/ref/index.ts'],
    };

    const candidates: TaskChangeCandidate[] = [
      { path: 'packages/app/index.ts', tracked: true }, // inside packages/app -> permitted
      { path: 'packages/application/index.ts', tracked: true }, // string-prefix sibling -> drift
      { path: 'packages/app-utils/helper.ts', tracked: true }, // string-prefix sibling -> drift
      { path: 'packages/lib/index.ts', tracked: true }, // inside packages/lib -> nonGoal
      { path: 'packages/lib-extra/index.ts', tracked: true }, // string-prefix sibling -> drift
      { path: 'packages/ref/index.ts', tracked: true }, // inside packages/ref -> reference
      { path: 'packages/ref-legacy/index.ts', tracked: true }, // string-prefix sibling -> drift
    ];

    const result = classifyTaskChanges({
      candidates,
      currentScope,
    });

    expect(result.permittedPaths).toEqual(['packages/app/index.ts']);
    expect(result.nonGoalFiles).toEqual(['packages/lib/index.ts']);
    expect(result.modifiedReferenceFiles).toEqual(['packages/ref/index.ts']);
    expect(result.driftFiles).toEqual([
      'packages/app-utils/helper.ts',
      'packages/application/index.ts',
      'packages/lib-extra/index.ts',
      'packages/ref-legacy/index.ts',
    ]);
  });

  // Invariant: candidate-only-permission
  it('returns only approved candidate paths without directory expansion', () => {
    const currentScope: EffectiveTaskScope = {
      requiredFiles: ['src/a.ts'],
      mayExtendFiles: ['src/b.ts'],
      permittedAreas: ['src/services', 'packages/core'],
      nonGoals: [],
      referenceFiles: [],
    };

    const candidates: TaskChangeCandidate[] = [
      { path: 'src/services/user.ts', tracked: true },
      { path: 'src/a.ts', tracked: true },
    ];

    const result = classifyTaskChanges({
      candidates,
      currentScope,
    });

    // permittedPaths contains only concrete candidate paths that were inspected, no directory names or uninspected paths
    expect(result.permittedPaths).toEqual(['src/a.ts', 'src/services/user.ts']);
    expect(result.permittedPaths).not.toContain('src/services');
    expect(result.permittedPaths).not.toContain('packages/core');
    expect(result.permittedPaths).not.toContain('src/b.ts');
  });

  describe('table-driven and edge cases', () => {
    it('classifies protected orchestrator artifacts, patches, and diffs as protected', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: ['task-manifest.json', 'result.json'],
        mayExtendFiles: ['.gitignore'],
        permittedAreas: ['.github', '.ai-tmp'],
        nonGoals: [],
        referenceFiles: [],
      };

      const candidates: (string | TaskChangeCandidate)[] = [
        '.gitignore',
        '.ai-orchestrator.json',
        '.github/workflows/ci.yml',
        'task-manifest.json',
        'result.json',
        'scratch-files.json',
        '.ai-tmp/scratch-files.json',
        'changes.patch',
        'test.diff',
        'src/normal.ts',
      ];

      const result = classifyTaskChanges({
        candidates,
        currentScope,
      });

      expect(result.protectedFiles).toEqual([
        '.ai-orchestrator.json',
        '.ai-tmp/scratch-files.json',
        '.github/workflows/ci.yml',
        '.gitignore',
        'changes.patch',
        'result.json',
        'scratch-files.json',
        'task-manifest.json',
        'test.diff',
      ]);
      expect(result.driftFiles).toEqual(['src/normal.ts']);
      expect(result.permittedPaths).toEqual([]);
    });

    it('respects exemptFiles by exempting them from drift and reference violations', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: ['src/main.ts'],
        mayExtendFiles: [],
        permittedAreas: [],
        nonGoals: [],
        referenceFiles: ['src/exempt-ref.ts'],
      };

      const candidates: TaskChangeCandidate[] = [
        { path: 'src/main.ts', tracked: true },
        { path: 'src/exempt-drift.ts', tracked: true },
        { path: 'src/exempt-ref.ts', tracked: true },
        { path: 'src/unexempt-drift.ts', tracked: true },
      ];

      const result = classifyTaskChanges({
        candidates,
        currentScope,
        exemptFiles: ['src/exempt-drift.ts', 'src/exempt-ref.ts'],
      });

      expect(result.permittedPaths).toEqual(['src/main.ts']);
      expect(result.driftFiles).toEqual(['src/unexempt-drift.ts']);
      expect(result.modifiedReferenceFiles).toEqual([]);
    });

    it('normalizes paths and deduplicates / sorts output deterministically', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: ['src/b.ts', 'src/a.ts'],
        mayExtendFiles: [],
        permittedAreas: ['src/area'],
        nonGoals: [],
        referenceFiles: [],
      };

      const candidates: (string | TaskChangeCandidate)[] = [
        './src/b.ts',
        'src/b.ts',
        'src\\a.ts',
        { path: 'src//area/z.ts', tracked: true },
        { path: 'src/area/a.ts', tracked: true },
        { path: 'drift/b.ts', tracked: true },
        { path: 'drift/a.ts', tracked: true },
      ];

      const result = classifyTaskChanges({
        candidates,
        currentScope,
      });

      expect(result.permittedPaths).toEqual([
        'src/a.ts',
        'src/area/a.ts',
        'src/area/z.ts',
        'src/b.ts',
      ]);
      expect(result.driftFiles).toEqual(['drift/a.ts', 'drift/b.ts']);
    });

    it('supports alternative positional arguments signature', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: ['src/index.ts'],
        mayExtendFiles: ['src/helper.ts'],
        permittedAreas: [],
        nonGoals: [],
        referenceFiles: [],
      };

      const candidates = ['src/index.ts', 'src/helper.ts', 'src/other.ts'];

      const result = classifyTaskChanges(candidates, currentScope);

      expect(result.permittedPaths).toEqual(['src/helper.ts', 'src/index.ts']);
      expect(result.driftFiles).toEqual(['src/other.ts']);
    });

    it('treats empty / read-only scope as rejecting all candidates to drift', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: [],
        mayExtendFiles: [],
        permittedAreas: [],
        nonGoals: [],
        referenceFiles: [],
      };

      const candidates = [
        { path: 'src/file1.ts', tracked: true },
        { path: 'src/file2.ts', tracked: false },
      ];

      const result = classifyTaskChanges({
        candidates,
        currentScope,
      });

      expect(result.permittedPaths).toEqual([]);
      expect(result.driftFiles).toEqual(['src/file1.ts', 'src/file2.ts']);
    });

    it('correctly calculates implicit 1-based task numbers for downstream tasks when tasks lack explicit n field', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: ['src/task1.ts'],
        mayExtendFiles: [],
        permittedAreas: ['src'],
        nonGoals: [],
        referenceFiles: [],
      };

      // Implicit task numbers based on index in allTasks:
      // index 0 -> task 1 (current task)
      // index 1 -> task 2 (downstream)
      // index 2 -> task 3 (downstream)
      const manifestTasks = [
        { expected_files: ['src/task1.ts'] },
        { expected_files: ['src/task2.ts'] },
        { expected_files: ['src/task3.ts'] },
      ];

      const candidates: TaskChangeCandidate[] = [
        { path: 'src/task1.ts', tracked: true },
        { path: 'src/task2.ts', tracked: true },
        { path: 'src/task3.ts', tracked: true },
      ];

      const result = classifyTaskChanges({
        candidates,
        currentScope,
        manifestTasks,
        currentTaskNumber: 1,
      });

      expect(result.prematureImplementation).toEqual([
        { path: 'src/task2.ts', taskNumber: 2 },
        { path: 'src/task3.ts', taskNumber: 3 },
      ]);
      expect(result.permittedPaths).toEqual(['src/task1.ts']);
    });

    it('permits current task requiredFiles even if downstream tasks also expect the same files', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: ['src/shared.ts'],
        mayExtendFiles: ['src/extend-downstream.ts'],
        permittedAreas: ['src'],
        nonGoals: [],
        referenceFiles: [],
      };

      const manifestTasks = [
        { n: 1, expected_files: ['src/shared.ts'] },
        { n: 2, expected_files: ['src/shared.ts', 'src/extend-downstream.ts'] },
      ];

      const candidates: TaskChangeCandidate[] = [
        { path: 'src/shared.ts', tracked: true },
        { path: 'src/extend-downstream.ts', tracked: true },
      ];

      const result = classifyTaskChanges({
        candidates,
        currentScope,
        manifestTasks,
        currentTaskNumber: 1,
      });

      // src/shared.ts is expected by current task, so permitted despite being in task 2 expected_files
      // src/extend-downstream.ts is only may_extend for current task, so downstream ownership takes precedence
      expect(result.permittedPaths).toEqual(['src/shared.ts']);
      expect(result.prematureImplementation).toEqual([
        { path: 'src/extend-downstream.ts', taskNumber: 2 },
      ]);
    });

    it('resolves .. and . path traversal segments to prevent bypassing protected file checks', () => {
      expect(normalizeTaskPath('src/../.github/workflows/ci.yml')).toBe('.github/workflows/ci.yml');
      expect(normalizeTaskPath('../../.github/workflows/ci.yml')).toBe('.github/workflows/ci.yml');
      expect(normalizeTaskPath('src/./foo//bar/../baz.ts')).toBe('src/foo/baz.ts');
      expect(normalizeTaskPath('packages/application/src/../../domain/src/index.ts')).toBe(
        'packages/domain/src/index.ts',
      );

      const currentScope: EffectiveTaskScope = {
        requiredFiles: [],
        mayExtendFiles: [],
        permittedAreas: ['src'],
        nonGoals: [],
        referenceFiles: [],
      };

      const candidates: (string | TaskChangeCandidate)[] = [
        'src/../.github/workflows/ci.yml',
        'src/../.gitignore',
        'src/../task-manifest.json',
      ];

      const result = classifyTaskChanges({
        candidates,
        currentScope,
      });

      expect(result.protectedFiles).toEqual([
        '.github/workflows/ci.yml',
        '.gitignore',
        'task-manifest.json',
      ]);
      expect(result.permittedPaths).toEqual([]);
      expect(result.driftFiles).toEqual([]);
    });

    it('ignores exemptFiles within non-goal directories across all checks without flagging nonGoalFiles violations', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: ['src/main.ts'],
        mayExtendFiles: [],
        permittedAreas: ['src'],
        nonGoals: ['src/blocked', 'vendor'],
        referenceFiles: ['vendor/ref.ts'],
      };

      const candidates: TaskChangeCandidate[] = [
        { path: 'src/main.ts', tracked: true },
        { path: 'src/blocked/package-lock.json', tracked: true },
        { path: 'vendor/pnpm-lock.yaml', tracked: true },
        { path: 'src/blocked/malicious.ts', tracked: true },
      ];

      const result = classifyTaskChanges({
        candidates,
        currentScope,
        exemptFiles: ['src/blocked/package-lock.json', 'vendor/pnpm-lock.yaml'],
      });

      expect(result.permittedPaths).toEqual(['src/main.ts']);
      expect(result.nonGoalFiles).toEqual(['src/blocked/malicious.ts']);
      expect(result.modifiedReferenceFiles).toEqual([]);
      expect(result.driftFiles).toEqual([]);
    });

    it('offsets implicit task numbers when downstreamTasks is used with currentTaskNumber > 0', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: ['src/task2.ts'],
        mayExtendFiles: [],
        permittedAreas: [],
        nonGoals: [],
        referenceFiles: [],
      };

      const downstreamTasks = [
        { expected_files: ['src/task3.ts'] },
        { expected_files: ['src/task4.ts'] },
      ];

      const candidates: TaskChangeCandidate[] = [
        { path: 'src/task3.ts', tracked: true },
        { path: 'src/task4.ts', tracked: true },
      ];

      const result = classifyTaskChanges({
        candidates,
        currentScope,
        downstreamTasks,
        currentTaskNumber: 2,
      });

      expect(result.prematureImplementation).toEqual([
        { path: 'src/task3.ts', taskNumber: 3 },
        { path: 'src/task4.ts', taskNumber: 4 },
      ]);
    });
  });
});

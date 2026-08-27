import { describe, it, expect } from 'vitest';
import { findManifestTaskStakes, type EffectiveTaskScope } from '../../task-file-boundaries.js';
import {
  MAX_TERMINAL_FIX_CHANGED_LINES,
  TERMINAL_FIX_SCOPE_POLICY,
  isNarrowGitFileChange,
  reconcileTerminalFixScope,
  type ReconcileTerminalFixScopeInput,
} from '../terminal-fix-scope-policy.js';
import type { GitFileChangeSummary } from '../../ports/git-port.js';

describe('terminal-fix-scope-policy', () => {
  describe('manifest stakes detection', () => {
    it('finds exact expected legacy and reference stakes in earlier current and later tasks', () => {
      const manifestTasks = [
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['src/earlier.ts', 'src/shared.ts'],
        },
        {
          n: 2,
          title: 'Task 2',
          reference_files: ['src/current-ref.ts', 'src/shared.ts'],
        },
        {
          n: 3,
          title: 'Task 3',
          files: ['src/later-legacy.ts'],
        },
      ];

      // Exact match with earlier task expected_files
      const earlierStakes = findManifestTaskStakes('./src/earlier.ts', manifestTasks);
      expect(earlierStakes).toEqual([
        { path: 'src/earlier.ts', taskNumber: 1, field: 'expected_files' },
      ]);

      // Exact match with current task reference_files
      const refStakes = findManifestTaskStakes('src/current-ref.ts', manifestTasks);
      expect(refStakes).toEqual([
        { path: 'src/current-ref.ts', taskNumber: 2, field: 'reference_files' },
      ]);

      // Exact match with later task legacy files
      const laterStakes = findManifestTaskStakes('src/later-legacy.ts', manifestTasks);
      expect(laterStakes).toEqual([{ path: 'src/later-legacy.ts', taskNumber: 3, field: 'files' }]);

      // Shared file across multiple tasks and fields - sorted deterministically
      const sharedStakes = findManifestTaskStakes('src/shared.ts', manifestTasks);
      expect(sharedStakes).toEqual([
        { path: 'src/shared.ts', taskNumber: 1, field: 'expected_files' },
        { path: 'src/shared.ts', taskNumber: 2, field: 'reference_files' },
      ]);

      // Unowned file returns empty array
      expect(findManifestTaskStakes('src/unowned.ts', manifestTasks)).toEqual([]);
    });

    it('finds exact and directory-prefix non-goal stakes', () => {
      const manifestTasks = [
        {
          n: 1,
          title: 'Task 1',
          non_goals: ['src/core/blocked', 'docs/readme.md'],
        },
      ];

      // Exact match
      const exactStakes = findManifestTaskStakes('src/core/blocked', manifestTasks);
      expect(exactStakes).toEqual([
        { path: 'src/core/blocked', taskNumber: 1, field: 'non_goals' },
      ]);

      // Segment prefix match (descendant)
      const descendantStakes = findManifestTaskStakes(
        'src/core/blocked/deep/file.ts',
        manifestTasks,
      );
      expect(descendantStakes).toEqual([
        { path: 'src/core/blocked/deep/file.ts', taskNumber: 1, field: 'non_goals' },
      ]);

      // Raw string prefix that is NOT segment prefix must not match
      const falsePrefixStakes = findManifestTaskStakes(
        'src/core/blocked-sibling.ts',
        manifestTasks,
      );
      expect(falsePrefixStakes).toEqual([]);

      // Other non-goal file
      const docStakes = findManifestTaskStakes('docs/readme.md', manifestTasks);
      expect(docStakes).toEqual([{ path: 'docs/readme.md', taskNumber: 1, field: 'non_goals' }]);
    });

    it('ignores may-extend and permitted-area declarations as ownership stakes', () => {
      const manifestTasks = [
        {
          n: 1,
          title: 'Task 1',
          may_extend: ['src/optional-extend.ts'],
          permitted_areas: ['src/services', 'src/utils'],
        },
        {
          n: 2,
          title: 'Task 2',
          may_extend: ['src/services/other.ts'],
        },
      ];

      // File in may_extend of another task should NOT be considered owned/staked
      expect(findManifestTaskStakes('src/optional-extend.ts', manifestTasks)).toEqual([]);

      // File in permitted_areas of another task should NOT be considered owned/staked
      expect(findManifestTaskStakes('src/services/api.ts', manifestTasks)).toEqual([]);
      expect(findManifestTaskStakes('src/utils/math.ts', manifestTasks)).toEqual([]);
    });
  });

  describe('narrow change policy', () => {
    it('accepts only one known non-binary modified entry at ten changed lines or fewer', () => {
      expect(MAX_TERMINAL_FIX_CHANGED_LINES).toBe(10);
      expect(TERMINAL_FIX_SCOPE_POLICY).toBe('unowned_narrow_v1');

      // 0 changed lines
      expect(
        isNarrowGitFileChange({
          path: 'src/fix.ts',
          status: 'modified',
          binary: false,
          additions: 0,
          deletions: 0,
        }),
      ).toBe(true);

      // 10 changed lines (5 additions + 5 deletions)
      expect(
        isNarrowGitFileChange({
          path: 'src/fix.ts',
          status: 'modified',
          binary: false,
          additions: 5,
          deletions: 5,
        }),
      ).toBe(true);

      // 10 additions + 0 deletions
      expect(
        isNarrowGitFileChange({
          path: 'src/fix.ts',
          status: 'modified',
          binary: false,
          additions: 10,
          deletions: 0,
        }),
      ).toBe(true);

      // 0 additions + 10 deletions
      expect(
        isNarrowGitFileChange({
          path: 'src/fix.ts',
          status: 'modified',
          binary: false,
          additions: 0,
          deletions: 10,
        }),
      ).toBe(true);
    });

    it('rejects eleven lines structural statuses binary unknown missing and duplicate summaries', () => {
      // 11 lines (6 + 5)
      expect(
        isNarrowGitFileChange({
          path: 'src/fix.ts',
          status: 'modified',
          binary: false,
          additions: 6,
          deletions: 5,
        }),
      ).toBe(false);

      // 11 lines (11 + 0)
      expect(
        isNarrowGitFileChange({
          path: 'src/fix.ts',
          status: 'modified',
          binary: false,
          additions: 11,
          deletions: 0,
        }),
      ).toBe(false);

      // Structural statuses
      const structuralStatuses: GitFileChangeSummary['status'][] = [
        'added',
        'deleted',
        'renamed',
        'copied',
        'type_changed',
        'unknown',
      ];
      for (const status of structuralStatuses) {
        expect(
          isNarrowGitFileChange({
            path: 'src/fix.ts',
            status,
            binary: false,
            additions: 1,
            deletions: 1,
          }),
        ).toBe(false);
      }

      // Binary
      expect(
        isNarrowGitFileChange({
          path: 'src/fix.png',
          status: 'modified',
          binary: true,
          additions: 1,
          deletions: 1,
        }),
      ).toBe(false);

      // Unknown line counts (null)
      expect(
        isNarrowGitFileChange({
          path: 'src/fix.ts',
          status: 'modified',
          binary: false,
          additions: null,
          deletions: 1,
        }),
      ).toBe(false);
      expect(
        isNarrowGitFileChange({
          path: 'src/fix.ts',
          status: 'modified',
          binary: false,
          additions: 1,
          deletions: null,
        }),
      ).toBe(false);

      // Undefined or null summary
      expect(isNarrowGitFileChange(null)).toBe(false);
      expect(isNarrowGitFileChange(undefined)).toBe(false);

      // In reconcileTerminalFixScope: missing summary
      const currentScope: EffectiveTaskScope = {
        requiredFiles: ['src/task.ts'],
        mayExtendFiles: [],
        permittedAreas: [],
        nonGoals: [],
        referenceFiles: [],
      };

      const missingSummaryResult = reconcileTerminalFixScope({
        candidates: ['src/drift.ts'],
        currentScope,
        fileSummaries: [], // Missing summary for src/drift.ts
      });
      expect(missingSummaryResult.granted).toBe(false);
      if (!missingSummaryResult.granted) {
        expect(missingSummaryResult.reason).toBe('missing_summary');
      }

      // In reconcileTerminalFixScope: duplicate/ambiguous summaries
      const duplicateSummaryResult = reconcileTerminalFixScope({
        candidates: ['src/drift.ts'],
        currentScope,
        fileSummaries: [
          {
            path: 'src/drift.ts',
            status: 'modified',
            binary: false,
            additions: 1,
            deletions: 1,
          },
          {
            path: 'src/drift.ts',
            status: 'modified',
            binary: false,
            additions: 2,
            deletions: 2,
          },
        ],
      });
      expect(duplicateSummaryResult.granted).toBe(false);
      if (!duplicateSummaryResult.granted) {
        expect(duplicateSummaryResult.reason).toBe('ambiguous_summary');
      }
    });
  });

  describe('atomic candidate reconciliation and immutability', () => {
    it('rejects the entire candidate set when any violation is protected claimed excluded reference-owned or non-narrow', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: ['src/task.ts'],
        mayExtendFiles: [],
        permittedAreas: [],
        nonGoals: ['src/non-goal'],
        referenceFiles: ['src/reference.ts'],
      };

      const manifestTasks = [
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['src/task.ts'],
          reference_files: ['src/reference.ts'],
          non_goals: ['src/non-goal'],
        },
        {
          n: 2,
          title: 'Task 2',
          expected_files: ['src/claimed-by-later.ts'],
        },
      ];

      const validSummary1: GitFileChangeSummary = {
        path: 'src/valid-drift.ts',
        status: 'modified',
        binary: false,
        additions: 2,
        deletions: 1,
      };

      // 1. Violation: Protected file in candidates
      const protectedResult = reconcileTerminalFixScope({
        candidates: ['src/valid-drift.ts', '.ai-orchestrator.json'],
        currentScope,
        manifestTasks,
        currentTaskNumber: 1,
        fileSummaries: [
          validSummary1,
          {
            path: '.ai-orchestrator.json',
            status: 'modified',
            binary: false,
            additions: 1,
            deletions: 0,
          },
        ],
      });
      expect(protectedResult.granted).toBe(false);
      if (!protectedResult.granted) {
        expect(protectedResult.reason).toBe('categorical_boundary');
      }

      // 2. Violation: Claimed by another task
      const claimedResult = reconcileTerminalFixScope({
        candidates: ['src/valid-drift.ts', 'src/claimed-by-later.ts'],
        currentScope,
        manifestTasks,
        currentTaskNumber: 1,
        fileSummaries: [
          validSummary1,
          {
            path: 'src/claimed-by-later.ts',
            status: 'modified',
            binary: false,
            additions: 1,
            deletions: 0,
          },
        ],
      });
      expect(claimedResult.granted).toBe(false);
      if (!claimedResult.granted) {
        expect(claimedResult.reason).toBe('manifest_stake');
      }

      // 3. Violation: Excluded by non-goal
      const nonGoalResult = reconcileTerminalFixScope({
        candidates: ['src/valid-drift.ts', 'src/non-goal/file.ts'],
        currentScope,
        manifestTasks,
        currentTaskNumber: 1,
        fileSummaries: [
          validSummary1,
          {
            path: 'src/non-goal/file.ts',
            status: 'modified',
            binary: false,
            additions: 1,
            deletions: 0,
          },
        ],
      });
      expect(nonGoalResult.granted).toBe(false);
      if (!nonGoalResult.granted) {
        expect(['categorical_boundary', 'manifest_stake']).toContain(nonGoalResult.reason);
      }

      // 4. Violation: Reference-owned
      const referenceResult = reconcileTerminalFixScope({
        candidates: ['src/valid-drift.ts', 'src/reference.ts'],
        currentScope,
        manifestTasks,
        currentTaskNumber: 1,
        fileSummaries: [
          validSummary1,
          {
            path: 'src/reference.ts',
            status: 'modified',
            binary: false,
            additions: 1,
            deletions: 0,
          },
        ],
      });
      expect(referenceResult.granted).toBe(false);
      if (!referenceResult.granted) {
        expect(['categorical_boundary', 'manifest_stake']).toContain(referenceResult.reason);
      }

      // 5. Violation: Non-narrow (> 10 lines)
      const nonNarrowResult = reconcileTerminalFixScope({
        candidates: ['src/valid-drift.ts', 'src/large-drift.ts'],
        currentScope,
        manifestTasks,
        currentTaskNumber: 1,
        fileSummaries: [
          validSummary1,
          {
            path: 'src/large-drift.ts',
            status: 'modified',
            binary: false,
            additions: 15,
            deletions: 2,
          },
        ],
      });
      expect(nonNarrowResult.granted).toBe(false);
      if (!nonNarrowResult.granted) {
        expect(nonNarrowResult.reason).toBe('non_narrow_summary');
      }
    });

    it('returns a sorted immutable overlay without mutating the manifest or current scope', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: ['src/task.ts'],
        mayExtendFiles: ['src/existing-extend.ts'],
        permittedAreas: [],
        nonGoals: [],
        referenceFiles: [],
      };

      const manifestTasks = [
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['src/task.ts'],
          may_extend: ['src/existing-extend.ts'],
        },
      ];

      const currentScopeSnapshot = JSON.parse(JSON.stringify(currentScope));
      const manifestTasksSnapshot = JSON.parse(JSON.stringify(manifestTasks));

      const summaries: GitFileChangeSummary[] = [
        {
          path: 'src/z-drift.ts',
          status: 'modified',
          binary: false,
          additions: 2,
          deletions: 1,
        },
        {
          path: 'src/a-drift.ts',
          status: 'modified',
          binary: false,
          additions: 3,
          deletions: 0,
        },
      ];

      const input: ReconcileTerminalFixScopeInput = {
        candidates: ['src/z-drift.ts', 'src/a-drift.ts'],
        currentScope,
        manifestTasks,
        currentTaskNumber: 1,
        fileSummaries: summaries,
      };

      const result = reconcileTerminalFixScope(input);

      expect(result.granted).toBe(true);
      if (result.granted) {
        expect(result.decision).toBe('grant');
        expect(result.policy).toBe('unowned_narrow_v1');
        // Sorted granted paths
        expect(result.grantedPaths).toEqual(['src/a-drift.ts', 'src/z-drift.ts']);
        // Overlay scope includes existing mayExtendFiles plus new granted paths, sorted and deduplicated
        expect(result.overlayScope.mayExtendFiles).toEqual([
          'src/a-drift.ts',
          'src/existing-extend.ts',
          'src/z-drift.ts',
        ]);
        expect(result.overlayScope.requiredFiles).toEqual(['src/task.ts']);
      }

      // Assert inputs were not mutated and remain deep equal to their snapshots
      expect(currentScope).toEqual(currentScopeSnapshot);
      expect(manifestTasks).toEqual(manifestTasksSnapshot);
    });
  });
});

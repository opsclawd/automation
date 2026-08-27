import { describe, it, expect, vi } from 'vitest';
import {
  getManifestBoundaries,
  checkTaskBoundaries,
  loadManifest,
  isPathPermittedByScope,
  classifyTaskChanges,
  isFileOwnedByAnyTask,
  getFileDiffLineCount,
  type EffectiveTaskScope,
  type TaskChangeCandidate,
} from '../task-file-boundaries.js';

describe('task-file-boundaries helpers', () => {
  it('extracts all declared writable (expected_files + may_extend) and reference files across all tasks in a manifest', () => {
    const manifest = {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['src/a.ts', 'src/common.ts'],
          may_extend: ['src/ext1.ts'],
          reference_files: ['src/ref1.ts'],
        },
        {
          n: 2,
          title: 'Task 2',
          expected_files: ['src/b.ts'],
          may_extend: ['src/ext2.ts'],
          reference_files: ['src/ref2.ts'],
        },
      ],
    };

    const boundaries = getManifestBoundaries(manifest);
    expect(Array.from(boundaries.writableSet).sort()).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/common.ts',
      'src/ext1.ts',
      'src/ext2.ts',
    ]);
    expect(Array.from(boundaries.referenceSet).sort()).toEqual(['src/ref1.ts', 'src/ref2.ts']);
  });

  it('classifies committed files using manifest boundaries and V2 scope rules', () => {
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['src/core/declared.ts'],
          permitted_areas: ['src/core/extra', 'src/common'],
          may_extend: ['src/utils/helper.ts'],
          reference_files: ['src/core/read-only.ts'],
          non_goals: ['src/core/extra/blocked'],
        },
      ],
    };

    const committed = [
      'src/core/declared.ts', // required file -> permitted
      'src/core/sibling.ts', // derived parent area (src/core) -> permitted
      'src/core/extra/file.ts', // explicit permitted area -> permitted
      'src/common/shared.ts', // explicit permitted area -> permitted
      'src/utils/helper.ts', // exact may_extend -> permitted
      'src/core/read-only.ts', // reference file -> modifiedReferenceFiles
      'src/core/extra/blocked/file.ts', // non-goal -> undeclaredFiles
      'src/utils/other.ts', // outside may_extend exact match -> undeclaredFiles
      'other/rogue.ts', // outside all permitted scopes -> undeclaredFiles
    ];
    const result = checkTaskBoundaries(committed, manifest);

    expect(result.modifiedReferenceFiles).toEqual(['src/core/read-only.ts']);
    expect(result.undeclaredFiles).toEqual([
      'other/rogue.ts',
      'src/core/extra/blocked/file.ts',
      'src/utils/other.ts',
    ]);
  });

  it('enforces that root-level expected files do not derive repository-root permission', () => {
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['package.json'],
        },
      ],
    };

    const committed = ['package.json', 'README.md', 'src/foo.ts'];
    const result = checkTaskBoundaries(committed, manifest);

    expect(result.modifiedReferenceFiles).toEqual([]);
    expect(result.undeclaredFiles).toEqual(['README.md', 'src/foo.ts']);
  });

  it('enforces that empty/read-only tasks reject all non-exempt file changes', () => {
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1',
          expected_files: [],
        },
      ],
    };

    const committed = ['src/foo.ts', 'package.json'];
    const result = checkTaskBoundaries(committed, manifest);

    expect(result.modifiedReferenceFiles).toEqual([]);
    expect(result.undeclaredFiles).toEqual(['package.json', 'src/foo.ts']);
  });

  it('respects exemptFiles and orchestrator artifact exemptions in checkTaskBoundaries', () => {
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['src/core/declared.ts'],
        },
      ],
    };

    const committed = [
      'src/core/declared.ts',
      'exempt/file.ts',
      'task-manifest.json',
      'result.json',
      'other/rogue.ts',
    ];
    const result = checkTaskBoundaries(committed, manifest, ['exempt/file.ts']);

    expect(result.modifiedReferenceFiles).toEqual([]);
    expect(result.undeclaredFiles).toEqual(['other/rogue.ts']);
  });

  it('handles empty or missing manifest gracefully', () => {
    const boundaries = getManifestBoundaries(undefined);
    expect(boundaries.writableSet.size).toBe(0);
    expect(boundaries.referenceSet.size).toBe(0);

    const result = checkTaskBoundaries(['src/foo.ts'], undefined);
    expect(result.modifiedReferenceFiles).toEqual([]);
    expect(result.undeclaredFiles).toEqual(['src/foo.ts']);
  });

  describe('isPathPermittedByScope', () => {
    it('gives requiredFiles precedence over referenceFiles', () => {
      const scope = {
        requiredFiles: ['src/shared.ts'],
        mayExtendFiles: [],
        permittedAreas: [],
        nonGoals: [],
        referenceFiles: ['src/shared.ts'],
      };
      expect(isPathPermittedByScope('src/shared.ts', scope)).toBe(true);
    });

    it('rejects protected paths even when enclosed in permitted_areas', () => {
      const scope = {
        requiredFiles: [],
        mayExtendFiles: [],
        permittedAreas: ['.github', '.'],
        nonGoals: [],
        referenceFiles: [],
      };
      expect(isPathPermittedByScope('.github/workflows/ci.yml', scope)).toBe(false);
      expect(isPathPermittedByScope('.gitignore', scope)).toBe(false);
      expect(isPathPermittedByScope('task-manifest.json', scope)).toBe(false);
    });

    it('rejects non-goal paths even if explicitly declared in requiredFiles or permittedAreas', () => {
      const scope = {
        requiredFiles: ['src/blocked/req.ts'],
        mayExtendFiles: [],
        permittedAreas: ['src/blocked'],
        nonGoals: ['src/blocked'],
        referenceFiles: [],
      };
      expect(isPathPermittedByScope('src/blocked/req.ts', scope)).toBe(false);
      expect(isPathPermittedByScope('src/blocked/other.ts', scope)).toBe(false);
    });

    it('rejects referenceFiles when colliding with mayExtendFiles or permittedAreas', () => {
      const scope = {
        requiredFiles: [],
        mayExtendFiles: ['src/ref-ext.ts'],
        permittedAreas: ['src/area'],
        nonGoals: [],
        referenceFiles: ['src/ref-ext.ts', 'src/area/ref-area.ts'],
      };
      expect(isPathPermittedByScope('src/ref-ext.ts', scope)).toBe(false);
      expect(isPathPermittedByScope('src/area/ref-area.ts', scope)).toBe(false);
      expect(isPathPermittedByScope('src/area/allowed.ts', scope)).toBe(true);
    });
  });

  describe('loadManifest', () => {
    it('returns found when input.manifest is a valid object', async () => {
      const result = await loadManifest(
        { manifest: { tasks: [] } },
        { cwd: '/repo', runId: 'run-1' },
      );
      expect(result).toEqual({ status: 'found', manifest: { tasks: [] } });
    });

    it('returns malformed when input.manifest is a primitive', async () => {
      const result = await loadManifest(
        { manifest: 'not-an-object' },
        { cwd: '/repo', runId: 'run-1' },
      );
      expect(result.status).toBe('malformed');
    });

    it('loads from artifactStore when available with input.runId', async () => {
      const mockRead = vi.fn().mockResolvedValue(JSON.stringify({ version: 2, tasks: [] }));
      const result = await loadManifest(
        { runId: 'run-1' },
        { cwd: '/repo', runId: 'ctx-run-id' },
        { artifactStore: { read: mockRead } },
      );
      expect(mockRead).toHaveBeenCalledWith('run-1', 'task-manifest.json');
      expect(result).toEqual({ status: 'found', manifest: { version: 2, tasks: [] } });
    });

    it('falls back to ctx.runId when input.runId is missing', async () => {
      const mockRead = vi.fn().mockResolvedValue(JSON.stringify({ version: 2, tasks: [] }));
      const result = await loadManifest(
        {},
        { cwd: '/repo', runId: 'ctx-run-id' },
        { artifactStore: { read: mockRead } },
      );
      expect(mockRead).toHaveBeenCalledWith('ctx-run-id', 'task-manifest.json');
      expect(result).toEqual({ status: 'found', manifest: { version: 2, tasks: [] } });
    });

    it('falls back to readWorktreeFile when artifactStore throws not-found', async () => {
      const mockRead = vi.fn().mockRejectedValue(new Error('not found'));
      const mockReadWorktree = vi
        .fn()
        .mockResolvedValue(JSON.stringify({ version: 2, tasks: [{ n: 1 }] }));
      const result = await loadManifest(
        { runId: 'run-1' },
        { cwd: '/repo', runId: 'run-1' },
        {
          artifactStore: { read: mockRead },
          readWorktreeFile: mockReadWorktree,
        },
      );
      expect(mockReadWorktree).toHaveBeenCalledWith('/repo', 'task-manifest.json');
      expect(result).toEqual({ status: 'found', manifest: { version: 2, tasks: [{ n: 1 }] } });
    });

    it('returns malformed when artifactStore returns non-object JSON', async () => {
      const mockRead = vi.fn().mockResolvedValue('"just a string"');
      const result = await loadManifest(
        { runId: 'run-1' },
        { cwd: '/repo', runId: 'run-1' },
        { artifactStore: { read: mockRead } },
      );
      expect(result.status).toBe('malformed');
    });

    it('returns malformed when worktree file has invalid JSON', async () => {
      const mockReadWorktree = vi.fn().mockResolvedValue('{ not json');
      const result = await loadManifest(
        {},
        { cwd: '/repo', runId: 'run-1' },
        { readWorktreeFile: mockReadWorktree },
      );
      expect(result.status).toBe('malformed');
    });

    it('propagates non-not-found errors from artifactStore', async () => {
      const mockRead = vi.fn().mockRejectedValue(new Error('network timeout'));
      await expect(
        loadManifest(
          { runId: 'run-1' },
          { cwd: '/repo', runId: 'run-1' },
          { artifactStore: { read: mockRead } },
        ),
      ).rejects.toThrow('network timeout');
    });

    it('propagates permission denied errors from artifactStore', async () => {
      const mockRead = vi.fn().mockRejectedValue(new Error('permission denied'));
      await expect(
        loadManifest(
          { runId: 'run-1' },
          { cwd: '/repo', runId: 'run-1' },
          { artifactStore: { read: mockRead } },
        ),
      ).rejects.toThrow('permission denied');
    });

    it('propagates non-not-found errors from readWorktreeFile', async () => {
      const mockReadWorktree = vi.fn().mockRejectedValue(new Error('EACCES: permission denied'));
      await expect(
        loadManifest(
          { runId: 'run-1' },
          { cwd: '/repo', runId: 'run-1' },
          { readWorktreeFile: mockReadWorktree },
        ),
      ).rejects.toThrow('EACCES: permission denied');
    });

    it('returns malformed when input.manifest is an empty object', async () => {
      const result = await loadManifest({ manifest: {} }, { cwd: '/repo', runId: 'run-1' });
      expect(result.status).toBe('malformed');
      expect(result.error).toBe('manifest must be an object with a tasks property');
    });

    it('returns malformed when input.manifest lacks tasks property', async () => {
      const result = await loadManifest(
        { manifest: { version: 2 } },
        { cwd: '/repo', runId: 'run-1' },
      );
      expect(result.status).toBe('malformed');
      expect(result.error).toBe('manifest must be an object with a tasks property');
    });

    it('returns missing when manifest is not found anywhere', async () => {
      const mockRead = vi.fn().mockRejectedValue(new Error('not found'));
      const mockReadWorktree = vi.fn().mockResolvedValue(undefined);
      const result = await loadManifest(
        { runId: 'run-1' },
        { cwd: '/repo', runId: 'run-1' },
        {
          artifactStore: { read: mockRead },
          readWorktreeFile: mockReadWorktree,
        },
      );
      expect(result).toEqual({ status: 'missing', message: 'task-manifest.json not found' });
    });
  });

  describe('classifyTaskChanges downstream selection', () => {
    it('classifies only numeric downstream task deliverables', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: ['src/task2.ts'],
        mayExtendFiles: ['src/task1.ts', 'src/future.ts'],
        permittedAreas: [],
        nonGoals: [],
        referenceFiles: [],
      };

      const manifestTasks = [
        { n: 1, expected_files: ['src/task1.ts'] },
        { n: 2, expected_files: ['src/task2.ts'] },
        { n: 3, expected_files: ['src/future.ts'] },
      ];

      const candidates: TaskChangeCandidate[] = [
        { path: 'src/task1.ts', tracked: true },
        { path: 'src/task2.ts', tracked: true },
        { path: 'src/future.ts', tracked: true },
      ];

      const result = classifyTaskChanges({
        candidates,
        currentScope,
        manifestTasks,
        currentTaskNumber: 2,
      });

      expect(result.prematureImplementation).toEqual([{ path: 'src/future.ts', taskNumber: 3 }]);
      expect(result.permittedPaths).toEqual(['src/task1.ts', 'src/task2.ts']);
    });

    it('normalizes duplicate candidates and selects the earliest downstream owner', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: ['src/task1.ts'],
        mayExtendFiles: [],
        permittedAreas: [],
        nonGoals: [],
        referenceFiles: [],
      };

      // manifestTasks provided with higher task number first
      const manifestTasks = [
        { n: 4, expected_files: ['src/future.ts'] },
        { n: 2, expected_files: ['./src/future.ts'] },
        { n: 3, expected_files: ['src//future.ts'] },
      ];

      // Committed and dirty aliases for candidate
      const candidates: (string | TaskChangeCandidate)[] = [
        { path: 'src/future.ts', tracked: true },
        { path: './src/future.ts', tracked: false },
        'src//future.ts',
      ];

      const result = classifyTaskChanges({
        candidates,
        currentScope,
        manifestTasks,
        currentTaskNumber: 1,
      });

      expect(result.prematureImplementation).toEqual([{ path: 'src/future.ts', taskNumber: 2 }]);

      // Also test downstreamTasks option with out-of-order array
      const downstreamResult = classifyTaskChanges({
        candidates,
        currentScope,
        downstreamTasks: [
          { n: 5, expected_files: ['src/future.ts'] },
          { n: 2, expected_files: ['src/future.ts'] },
          { n: 3, expected_files: ['src/future.ts'] },
        ],
        currentTaskNumber: 1,
      });

      expect(downstreamResult.prematureImplementation).toEqual([
        { path: 'src/future.ts', taskNumber: 2 },
      ]);
    });

    it('treats downstream legacy files as required deliverables', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: ['src/task1.ts'],
        mayExtendFiles: [],
        permittedAreas: [],
        nonGoals: [],
        referenceFiles: [],
      };

      const manifestTasks = [
        { n: 1, expected_files: ['src/task1.ts'] },
        { n: 2, files: ['src/legacy.ts'] },
      ];

      const candidates = ['src/legacy.ts'];

      const result = classifyTaskChanges({
        candidates,
        currentScope,
        manifestTasks,
        currentTaskNumber: 1,
      });

      expect(result.prematureImplementation).toEqual([{ path: 'src/legacy.ts', taskNumber: 2 }]);
    });
  });

  describe('classifyTaskChanges downstream precedence', () => {
    it('gives downstream expected files precedence over broad current-task permissions', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: ['src/task1.ts'],
        mayExtendFiles: ['src/extendable.ts'],
        permittedAreas: ['src/area'],
        nonGoals: [],
        referenceFiles: ['src/referenced.ts'],
      };

      const manifestTasks = [
        { n: 1, expected_files: ['src/task1.ts'] },
        {
          n: 2,
          expected_files: [
            'src/referenced.ts',
            'src/extendable.ts',
            'src/area/nested.ts',
            'src/unpermitted/drift.ts',
          ],
        },
      ];

      const candidates: TaskChangeCandidate[] = [
        { path: 'src/task1.ts', tracked: true },
        { path: 'src/referenced.ts', tracked: true },
        { path: 'src/extendable.ts', tracked: true },
        { path: 'src/area/nested.ts', tracked: true },
        { path: 'src/unpermitted/drift.ts', tracked: true },
        { path: 'src/area/local.ts', tracked: true },
      ];

      const result = classifyTaskChanges({
        candidates,
        currentScope,
        manifestTasks,
        currentTaskNumber: 1,
      });

      // Downstream expected_files beats reference_files, may_extend, permitted_areas, and generic drift
      expect(result.prematureImplementation).toEqual([
        { path: 'src/area/nested.ts', taskNumber: 2 },
        { path: 'src/extendable.ts', taskNumber: 2 },
        { path: 'src/referenced.ts', taskNumber: 2 },
        { path: 'src/unpermitted/drift.ts', taskNumber: 2 },
      ]);
      expect(result.modifiedReferenceFiles).toEqual([]);
      expect(result.permittedPaths).toEqual(['src/area/local.ts', 'src/task1.ts']);
      expect(result.driftFiles).toEqual([]);
    });

    it('gives current expected files precedence over duplicate downstream declarations', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: ['src/shared-obligation.ts'],
        mayExtendFiles: [],
        permittedAreas: [],
        nonGoals: ['src/blocked.ts'],
        referenceFiles: [],
      };

      const manifestTasks = [
        { n: 1, expected_files: ['src/shared-obligation.ts'] },
        {
          n: 2,
          expected_files: [
            'src/shared-obligation.ts',
            'src/blocked.ts',
            '.gitignore',
            'task-manifest.json',
          ],
        },
      ];

      const candidates: (string | TaskChangeCandidate)[] = [
        'src/shared-obligation.ts',
        'src/blocked.ts',
        '.gitignore',
        'task-manifest.json',
      ];

      const result = classifyTaskChanges({
        candidates,
        currentScope,
        manifestTasks,
        currentTaskNumber: 1,
      });

      // Current required file wins over duplicate downstream declaration
      expect(result.permittedPaths).toEqual(['src/shared-obligation.ts']);
      // Non-goals and protected paths retain precedence over downstream declaration
      expect(result.nonGoalFiles).toEqual(['src/blocked.ts']);
      expect(result.protectedFiles).toEqual(['.gitignore', 'task-manifest.json']);
      // None of the higher-precedence collisions fall through to prematureImplementation
      expect(result.prematureImplementation).toEqual([]);
    });

    it('proves downstream expected files beats reference files individually', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: [],
        mayExtendFiles: [],
        permittedAreas: [],
        nonGoals: [],
        referenceFiles: ['src/ref.ts'],
      };

      const result = classifyTaskChanges({
        candidates: ['src/ref.ts'],
        currentScope,
        downstreamTasks: [{ n: 2, expected_files: ['src/ref.ts'] }],
        currentTaskNumber: 1,
      });

      expect(result.prematureImplementation).toEqual([{ path: 'src/ref.ts', taskNumber: 2 }]);
      expect(result.modifiedReferenceFiles).toEqual([]);
    });

    it('proves downstream expected files beats may_extend individually', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: [],
        mayExtendFiles: ['src/ext.ts'],
        permittedAreas: [],
        nonGoals: [],
        referenceFiles: [],
      };

      const result = classifyTaskChanges({
        candidates: ['src/ext.ts'],
        currentScope,
        downstreamTasks: [{ n: 2, expected_files: ['src/ext.ts'] }],
        currentTaskNumber: 1,
      });

      expect(result.prematureImplementation).toEqual([{ path: 'src/ext.ts', taskNumber: 2 }]);
      expect(result.permittedPaths).toEqual([]);
    });

    it('proves downstream expected files beats permitted areas individually', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: [],
        mayExtendFiles: [],
        permittedAreas: ['src/area'],
        nonGoals: [],
        referenceFiles: [],
      };

      const result = classifyTaskChanges({
        candidates: [{ path: 'src/area/child.ts', tracked: true }],
        currentScope,
        downstreamTasks: [{ n: 2, expected_files: ['src/area/child.ts'] }],
        currentTaskNumber: 1,
      });

      expect(result.prematureImplementation).toEqual([
        { path: 'src/area/child.ts', taskNumber: 2 },
      ]);
      expect(result.permittedPaths).toEqual([]);
    });

    it('proves downstream expected files beats generic drift individually', () => {
      const currentScope: EffectiveTaskScope = {
        requiredFiles: [],
        mayExtendFiles: [],
        permittedAreas: [],
        nonGoals: [],
        referenceFiles: [],
      };

      const result = classifyTaskChanges({
        candidates: ['src/unpermitted.ts'],
        currentScope,
        downstreamTasks: [{ n: 2, expected_files: ['src/unpermitted.ts'] }],
        currentTaskNumber: 1,
      });

      expect(result.prematureImplementation).toEqual([
        { path: 'src/unpermitted.ts', taskNumber: 2 },
      ]);
      expect(result.driftFiles).toEqual([]);
    });
  });

  describe('isFileOwnedByAnyTask', () => {
    it('claim fields are exact normalized ownership claims with provenance', () => {
      const manifest = {
        version: 2,
        task_count: 4,
        tasks: [
          {
            n: 1,
            expected_files: ['./src/a.ts'],
          },
          {
            task_number: 2,
            files: ['src//b.ts'],
          },
          {
            // fallback index 2 -> taskNumber 3
            may_extend: ['src/c.ts'],
          },
          {
            n: 4,
            reference_files: ['src/d.ts'],
          },
        ],
      };

      expect(isFileOwnedByAnyTask('src/a.ts', manifest)).toEqual({
        owned: true,
        claims: [{ taskNumber: 1, field: 'expected_files' }],
      });
      expect(isFileOwnedByAnyTask('./src/b.ts', manifest)).toEqual({
        owned: true,
        claims: [{ taskNumber: 2, field: 'files' }],
      });
      expect(isFileOwnedByAnyTask('src//c.ts', manifest)).toEqual({
        owned: true,
        claims: [{ taskNumber: 3, field: 'may_extend' }],
      });
      expect(isFileOwnedByAnyTask('src/d.ts', manifest)).toEqual({
        owned: true,
        claims: [{ taskNumber: 4, field: 'reference_files' }],
      });
      expect(isFileOwnedByAnyTask('src/unowned.ts', manifest)).toEqual({
        owned: false,
        claims: [],
      });
    });

    it('returns every distinct claim in deterministic task and field order', () => {
      const manifest = {
        version: 2,
        task_count: 2,
        tasks: [
          {
            n: 1,
            expected_files: ['src/shared.ts', './src/shared.ts'],
            files: ['src/shared.ts'],
            may_extend: ['src/shared.ts'],
            reference_files: ['src/shared.ts'],
          },
          {
            n: 2,
            expected_files: ['src/shared.ts'],
            reference_files: ['src/shared.ts'],
          },
        ],
      };

      expect(isFileOwnedByAnyTask('src/shared.ts', manifest)).toEqual({
        owned: true,
        claims: [
          { taskNumber: 1, field: 'expected_files' },
          { taskNumber: 1, field: 'files' },
          { taskNumber: 1, field: 'may_extend' },
          { taskNumber: 1, field: 'reference_files' },
          { taskNumber: 2, field: 'expected_files' },
          { taskNumber: 2, field: 'reference_files' },
        ],
      });
    });

    it('non_goals and permitted_areas never create ownership', () => {
      const manifest = {
        version: 2,
        task_count: 2,
        tasks: [
          {
            n: 1,
            permitted_areas: ['src/dir', 'src/exact.ts'],
            non_goals: ['src/exact.ts', 'src/dir'],
          },
          {
            n: 2,
            non_goals: ['src/broad-exclusion', 'src/other.ts'],
            permitted_areas: ['packages/domain'],
          },
        ],
      };

      expect(isFileOwnedByAnyTask('src/exact.ts', manifest)).toEqual({
        owned: false,
        claims: [],
      });
      expect(isFileOwnedByAnyTask('src/dir/nested.ts', manifest)).toEqual({
        owned: false,
        claims: [],
      });
      expect(isFileOwnedByAnyTask('src/broad-exclusion/file.ts', manifest)).toEqual({
        owned: false,
        claims: [],
      });
      expect(isFileOwnedByAnyTask('packages/domain/src/file.ts', manifest)).toEqual({
        owned: false,
        claims: [],
      });
    });

    it('reproduces issue 96 without treating broad sibling non_goals as claims', () => {
      const manifest = {
        version: 2,
        task_count: 3,
        tasks: [
          {
            n: 1,
            expected_files: [
              'packages/domain/src/render-job.ts',
              'packages/domain/src/render-job.test.ts',
            ],
            non_goals: ['packages/infrastructure', 'apps', 'certification'],
          },
          {
            n: 2,
            expected_files: [
              'packages/infrastructure/migrations/007_job_dispatch_contract.sql',
              'packages/infrastructure/src/postgres/job-dispatch-contract.integration.test.ts',
            ],
            non_goals: [
              'packages/infrastructure/src/postgres/baseline-schema.integration.test.ts',
              'packages/application',
            ],
          },
          {
            n: 3,
            expected_files: [
              'packages/infrastructure/src/postgres/baseline-schema.integration.test.ts',
            ],
            non_goals: [
              'packages/infrastructure/migrations',
              'packages/domain',
              'packages/application',
            ],
          },
        ],
      };

      expect(
        isFileOwnedByAnyTask(
          'packages/infrastructure/src/postgres/audit-protections.integration.test.ts',
          manifest,
        ),
      ).toEqual({
        owned: false,
        claims: [],
      });

      expect(
        isFileOwnedByAnyTask(
          'packages/infrastructure/src/postgres/baseline-schema.integration.test.ts',
          manifest,
        ),
      ).toEqual({
        owned: true,
        claims: [{ taskNumber: 3, field: 'expected_files' }],
      });

      expect(isFileOwnedByAnyTask('packages/domain/src/render-job.ts', manifest)).toEqual({
        owned: true,
        claims: [{ taskNumber: 1, field: 'expected_files' }],
      });
    });

    it('returns no claims for invalid paths or manifests', () => {
      const validManifest = {
        tasks: [{ n: 1, expected_files: ['src/a.ts'] }],
      };

      expect(isFileOwnedByAnyTask('', validManifest)).toEqual({ owned: false, claims: [] });
      expect(isFileOwnedByAnyTask('   ', validManifest)).toEqual({ owned: false, claims: [] });
      expect(isFileOwnedByAnyTask('...', validManifest)).toEqual({ owned: false, claims: [] });
      expect(isFileOwnedByAnyTask('src/a.ts', null)).toEqual({ owned: false, claims: [] });
      expect(isFileOwnedByAnyTask('src/a.ts', undefined)).toEqual({ owned: false, claims: [] });
      expect(isFileOwnedByAnyTask('src/a.ts', 'string-manifest')).toEqual({
        owned: false,
        claims: [],
      });
      expect(isFileOwnedByAnyTask('src/a.ts', 123)).toEqual({ owned: false, claims: [] });
      expect(isFileOwnedByAnyTask('src/a.ts', {})).toEqual({ owned: false, claims: [] });
      expect(isFileOwnedByAnyTask('src/a.ts', { tasks: null })).toEqual({
        owned: false,
        claims: [],
      });
      expect(isFileOwnedByAnyTask('src/a.ts', { tasks: 'not-an-array' })).toEqual({
        owned: false,
        claims: [],
      });
      expect(isFileOwnedByAnyTask('src/a.ts', { tasks: [] })).toEqual({
        owned: false,
        claims: [],
      });
      expect(isFileOwnedByAnyTask('src/a.ts', { tasks: [{}] })).toEqual({
        owned: false,
        claims: [],
      });
      expect(isFileOwnedByAnyTask('src/a.ts', { tasks: [null, undefined, 'string-task'] })).toEqual(
        {
          owned: false,
          claims: [],
        },
      );
    });
  });

  describe('getFileDiffLineCount', () => {
    it('parses additions and deletions for target file from unified diff', () => {
      const diffText = `
diff --git a/src/unowned.ts b/src/unowned.ts
index 1234567..89abcdef 100644
--- a/src/unowned.ts
+++ b/src/unowned.ts
@@ -10,2 +10,2 @@
-  expect(val).toBe(6);
+  expect(val).toBe(7);
diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1,3 +1,5 @@
+new line 1
+new line 2
`;
      const unownedCount = getFileDiffLineCount(diffText, 'src/unowned.ts');
      expect(unownedCount).toEqual({ added: 1, deleted: 1, total: 2 });

      const otherCount = getFileDiffLineCount(diffText, 'src/other.ts');
      expect(otherCount).toEqual({ added: 2, deleted: 0, total: 2 });

      const missingCount = getFileDiffLineCount(diffText, 'src/absent.ts');
      expect(missingCount).toEqual({ added: 0, deleted: 0, total: 0 });
    });
  });
});

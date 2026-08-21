import { describe, it, expect, vi } from 'vitest';
import {
  getManifestBoundaries,
  checkTaskBoundaries,
  loadManifest,
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

    it('loads from artifactStore when available', async () => {
      const mockRead = vi.fn().mockResolvedValue(JSON.stringify({ version: 2, tasks: [] }));
      const result = await loadManifest(
        { runId: 'run-1' },
        { cwd: '/repo', runId: 'run-1' },
        { artifactStore: { read: mockRead } },
      );
      expect(mockRead).toHaveBeenCalledWith('run-1', 'task-manifest.json');
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
});

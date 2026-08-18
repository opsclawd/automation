import { describe, it, expect, vi } from 'vitest';
import {
  getManifestBoundaries,
  checkTaskBoundaries,
  loadManifest,
} from '../task-file-boundaries.js';

describe('task-file-boundaries helpers', () => {
  it('extracts all declared writable and reference files across all tasks in a manifest', () => {
    const manifest = {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['src/a.ts', 'src/common.ts'],
          reference_files: ['src/ref1.ts'],
        },
        {
          n: 2,
          title: 'Task 2',
          expected_files: ['src/b.ts'],
          reference_files: ['src/ref2.ts'],
        },
      ],
    };

    const boundaries = getManifestBoundaries(manifest);
    expect(Array.from(boundaries.writableSet).sort()).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/common.ts',
    ]);
    expect(Array.from(boundaries.referenceSet).sort()).toEqual(['src/ref1.ts', 'src/ref2.ts']);
  });

  it('classifies committed files using manifest boundaries', () => {
    const manifest = {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['src/declared.ts'],
          reference_files: ['src/read-only.ts'],
        },
      ],
    };

    const committed = ['src/declared.ts', 'src/read-only.ts', 'src/rogue.ts'];
    const result = checkTaskBoundaries(committed, manifest);

    expect(result.modifiedReferenceFiles).toEqual(['src/read-only.ts']);
    expect(result.undeclaredFiles).toEqual(['src/rogue.ts']);
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
        {},
        { cwd: '/repo', runId: 'run-1' },
        { artifactStore: { read: mockRead } },
      );
      expect(mockRead).toHaveBeenCalledWith('run-1', 'task-manifest.json');
      expect(result).toEqual({ status: 'found', manifest: { version: 2, tasks: [] } });
    });

    it('falls back to readWorktreeFile when artifactStore throws', async () => {
      const mockRead = vi.fn().mockRejectedValue(new Error('not found'));
      const mockReadWorktree = vi
        .fn()
        .mockResolvedValue(JSON.stringify({ version: 2, tasks: [{ n: 1 }] }));
      const result = await loadManifest(
        {},
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
        {},
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

    it('returns missing when manifest is not found anywhere', async () => {
      const mockRead = vi.fn().mockRejectedValue(new Error('not found'));
      const mockReadWorktree = vi.fn().mockResolvedValue(undefined);
      const result = await loadManifest(
        {},
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

import { describe, it, expect } from 'vitest';
import { getManifestBoundaries, checkTaskBoundaries } from '../task-file-boundaries.js';

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
});

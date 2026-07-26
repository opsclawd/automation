import { describe, expect, it } from 'vitest';
import { taskManifestEntryV2Schema, taskManifestSchema } from '../task-manifest.js';

describe('reference_files in task-manifest V2', () => {
  it('preserves reference_files on V2 task entries', () => {
    expect('reference_files' in taskManifestEntryV2Schema.shape).toBe(true);

    const parsed = taskManifestSchema.parse({
      version: 2,
      task_count: 1,
      tasks: [{ n: 1, title: 'Read callers', reference_files: ['src/caller.ts'] }],
    });

    expect(parsed.tasks[0]?.reference_files).toEqual(['src/caller.ts']);
  });

  it('accepts omitted and null reference_files for backward compatibility', () => {
    expect(() =>
      taskManifestSchema.parse({
        version: 2,
        task_count: 2,
        tasks: [
          { n: 1, title: 'Omitted' },
          { n: 2, title: 'Null', reference_files: null },
        ],
      }),
    ).not.toThrow();
  });

  it('does not treat reference_files as ownership of a changed declaration', () => {
    expect(() =>
      taskManifestSchema.parse({
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Invalid ownership',
            reference_files: ['src/api.ts'],
            signature_changes: [{ declaration_file: 'src/api.ts', symbol: 'createClient' }],
          },
        ],
      }),
    ).toThrow(/expected_files or files/);
  });
});

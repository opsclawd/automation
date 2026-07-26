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

  it('accepts a signature declaration_file listed in reference_files', () => {
    const parsed = taskManifestSchema.parse({
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Reference declaration',
          reference_files: ['src/api.ts'],
          signature_changes: [
            { declaration_file: 'src/api.ts', symbol: 'createClient', change: 'not_modified' },
          ],
        },
      ],
    });

    expect(parsed.tasks[0]?.signature_changes).toEqual([
      { declaration_file: 'src/api.ts', symbol: 'createClient', change: 'not_modified' },
    ]);
  });

  it('rejects a modified or added signature declaration_file listed only in reference_files', () => {
    expect(() =>
      taskManifestSchema.parse({
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Modified in reference files',
            reference_files: ['src/api.ts'],
            signature_changes: [
              { declaration_file: 'src/api.ts', symbol: 'createClient', change: 'modified' },
            ],
          },
        ],
      }),
    ).toThrow(/must be in expected_files or files/);

    expect(() =>
      taskManifestSchema.parse({
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Added in reference files',
            reference_files: ['src/api.ts'],
            signature_changes: [
              { declaration_file: 'src/api.ts', symbol: 'createClient', change: 'added' },
            ],
          },
        ],
      }),
    ).toThrow(/must be in expected_files or files/);
  });

  it('rejects a signature declaration_file absent from all task file lists', () => {
    expect(() =>
      taskManifestSchema.parse({
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Unlisted declaration',
            expected_files: ['src/expected.ts'],
            files: ['src/legacy.ts'],
            reference_files: ['src/ref.ts'],
            signature_changes: [
              {
                declaration_file: 'src/unlisted.ts',
                symbol: 'createClient',
                change: 'not_modified',
              },
            ],
          },
        ],
      }),
    ).toThrow(/expected_files, files, or reference_files/);
  });
});

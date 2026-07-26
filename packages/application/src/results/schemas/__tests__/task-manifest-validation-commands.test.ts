import { describe, expect, it } from 'vitest';
import { taskManifestV2Schema } from '../task-manifest.js';

describe('taskManifestV2Schema validation_commands', () => {
  it('parses V2 task containing string and argv validation commands', () => {
    const raw = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1',
          validation_commands: [
            'pnpm lint',
            ['pnpm', 'exec', 'eslint', 'apps/app/app/position/[id].tsx'],
          ],
        },
      ],
    };

    const parsed = taskManifestV2Schema.parse(raw);
    expect(parsed.tasks[0].validation_commands).toEqual([
      'pnpm lint',
      ['pnpm', 'exec', 'eslint', 'apps/app/app/position/[id].tsx'],
    ]);
  });

  it('rejects empty arrays, empty strings, and non-string argv members', () => {
    const invalidCommands = [[], [''], [['pnpm', 'exec', 'eslint', '']], [['pnpm', 123]], ['']];

    for (const invalidCmd of invalidCommands) {
      const raw = {
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Task 1',
            validation_commands: [invalidCmd],
          },
        ],
      };
      expect(() => taskManifestV2Schema.parse(raw)).toThrow();
    }
  });
});

import { describe, it, expect } from 'vitest';
import { taskManifestV2Schema } from '../task-manifest.js';

describe('taskManifestV2Schema execution semantics', () => {
  it('accepts valid task_type and paired_with_task', () => {
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'task 1',
          task_type: 'red',
          paired_with_task: 2,
        },
      ],
    };
    const result = taskManifestV2Schema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('rejects invalid task_type', () => {
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [{ n: 1, title: 'task 1', task_type: 'invalid_type' }],
    };
    const result = taskManifestV2Schema.safeParse(manifest);
    expect(result.success).toBe(false);
  });
});

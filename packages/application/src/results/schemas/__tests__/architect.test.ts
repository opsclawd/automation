import { describe, it, expect } from 'vitest';
import { architectPlanSchema } from '../architect.js';

describe('architectPlanSchema', () => {
  it('accepts a valid plan with one task', () => {
    const result = architectPlanSchema.safeParse({
      version: 1,
      tasks: [
        {
          task_id: 'C1',
          approach: 'Use if/else',
          conflicts_resolved: ['CONF-005'],
          constraints: ['set -euo pipefail'],
          depends_on: [],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts the legacy review-fix-plan.json shape verbatim', () => {
    const result = architectPlanSchema.safeParse({
      version: 1,
      tasks: [
        {
          task_id: 'C1',
          approach: 'Check before loop',
          conflicts_resolved: ['CONF-005'],
          constraints: ['Must not use for-in with set -u'],
          depends_on: [],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing version', () => {
    const result = architectPlanSchema.safeParse({
      tasks: [{ task_id: 'C1', approach: 'x' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty tasks array', () => {
    const result = architectPlanSchema.safeParse({ version: 1, tasks: [] });
    expect(result.success).toBe(false);
  });

  it('rejects missing approach on a task', () => {
    const result = architectPlanSchema.safeParse({
      version: 1,
      tasks: [{ task_id: 'C1' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty task_id', () => {
    const result = architectPlanSchema.safeParse({
      version: 1,
      tasks: [{ task_id: '   ', approach: 'x' }],
    });
    expect(result.success).toBe(false);
  });

  it('defaults optional arrays to []', () => {
    const result = architectPlanSchema.safeParse({
      version: 1,
      tasks: [{ task_id: 'C1', approach: 'x' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tasks[0]?.conflicts_resolved).toEqual([]);
      expect(result.data.tasks[0]?.constraints).toEqual([]);
      expect(result.data.tasks[0]?.depends_on).toEqual([]);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { plannerPackageSchema } from '../planner-package.js';

describe('plannerPackageSchema', () => {
  const validManifestV2 = {
    version: 2,
    task_count: 1,
    tasks: [
      {
        n: 1,
        title: 'Initial setup',
        description: 'Set up core modules',
        expected_files: ['src/index.ts'],
      },
    ],
  };

  it('accepts a valid planner package without task_manifest', () => {
    const parsed = plannerPackageSchema.safeParse({
      design_md: '# Design\n\nSome design',
      plan_md: '# Plan\n\n## Task 1: Initial setup',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.design_md).toBe('# Design\n\nSome design');
      expect(parsed.data.plan_md).toBe('# Plan\n\n## Task 1: Initial setup');
      expect(parsed.data.task_manifest).toBeUndefined();
    }
  });

  it('accepts a valid planner package with object task_manifest', () => {
    const parsed = plannerPackageSchema.safeParse({
      design_md: '# Design\n\nSome design',
      plan_md: '# Plan\n\n## Task 1: Initial setup',
      task_manifest: validManifestV2,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.design_md).toBe('# Design\n\nSome design');
      expect(parsed.data.plan_md).toBe('# Plan\n\n## Task 1: Initial setup');
      expect(parsed.data.task_manifest.version).toBe(2);
    }
  });

  it('accepts a valid planner package with JSON-stringified task_manifest', () => {
    const parsed = plannerPackageSchema.safeParse({
      design_md: '# Design\n\nSome design',
      plan_md: '# Plan\n\n## Task 1: Initial setup',
      task_manifest: JSON.stringify(validManifestV2),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.task_manifest.version).toBe(2);
      expect(parsed.data.task_manifest.tasks[0]?.title).toBe('Initial setup');
    }
  });

  it('rejects empty design_md or plan_md', () => {
    const res1 = plannerPackageSchema.safeParse({
      design_md: '   ',
      plan_md: '# Plan',
      task_manifest: validManifestV2,
    });
    expect(res1.success).toBe(false);

    const res2 = plannerPackageSchema.safeParse({
      design_md: '# Design',
      plan_md: '',
      task_manifest: validManifestV2,
    });
    expect(res2.success).toBe(false);
  });

  it('rejects malformed task_manifest JSON string', () => {
    const res = plannerPackageSchema.safeParse({
      design_md: '# Design',
      plan_md: '# Plan',
      task_manifest: '{ not valid json',
    });
    expect(res.success).toBe(false);
  });

  it('rejects invalid task_manifest structure', () => {
    const res = plannerPackageSchema.safeParse({
      design_md: '# Design',
      plan_md: '# Plan',
      task_manifest: { version: 99, tasks: [] },
    });
    expect(res.success).toBe(false);
  });
});

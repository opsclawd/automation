import { describe, expect, it } from 'vitest';
import {
  taskManifestSchema,
  taskManifestV1Schema,
  taskManifestV2Schema,
} from '../task-manifest.js';

describe('taskManifestV2Schema scope contract', () => {
  it('accepts normalized V2 permission declarations', () => {
    const validManifest = {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 'Implement core service and exports',
          expected_files: [
            'packages/core/src/service.ts',
            'packages/core/src/index.ts',
            'package.json',
          ],
          permitted_areas: ['packages/core/src', 'packages/core/test'],
          may_extend: ['packages/application/src/ports.ts'],
          non_goals: ['packages/infrastructure/src'],
          reference_files: ['packages/domain/src/entity.ts'],
          validation_commands: ['pnpm test'],
        },
        {
          n: 2,
          title: 'Root level deliverables',
          expected_files: ['README.md', 'packages/core/README.md'],
          permitted_areas: ['packages/core'],
          may_extend: [],
          non_goals: [],
          reference_files: ['package.json'],
        },
      ],
    };

    const result = taskManifestV2Schema.safeParse(validManifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tasks[0].expected_files).toEqual([
        'packages/core/src/service.ts',
        'packages/core/src/index.ts',
        'package.json',
      ]);
      expect(result.data.tasks[0].permitted_areas).toEqual([
        'packages/core/src',
        'packages/core/test',
      ]);
      expect(result.data.tasks[0].may_extend).toEqual(['packages/application/src/ports.ts']);
      expect(result.data.tasks[0].non_goals).toEqual(['packages/infrastructure/src']);
      expect(result.data.tasks[0].reference_files).toEqual(['packages/domain/src/entity.ts']);
    }

    const unifiedResult = taskManifestSchema.safeParse(validManifest);
    expect(unifiedResult.success).toBe(true);
  });

  it('defaults omitted and null scope declarations to empty behavior', () => {
    const v2Manifest = {
      version: 2,
      task_count: 3,
      tasks: [
        {
          n: 1,
          title: 'Omitted scope fields',
          expected_files: ['packages/core/src/service.ts'],
        },
        {
          n: 2,
          title: 'Null scope fields',
          expected_files: ['packages/core/src/service.ts'],
          permitted_areas: null,
          may_extend: null,
          non_goals: null,
          reference_files: null,
        },
        {
          n: 3,
          title: 'Empty scope fields',
          expected_files: [],
          permitted_areas: [],
          may_extend: [],
          non_goals: [],
          reference_files: [],
        },
      ],
    };

    const v2Result = taskManifestV2Schema.safeParse(v2Manifest);
    expect(v2Result.success).toBe(true);
    if (v2Result.success) {
      expect(v2Result.data.tasks[0].permitted_areas).toEqual([]);
      expect(v2Result.data.tasks[0].may_extend).toEqual([]);
      expect(v2Result.data.tasks[0].non_goals).toEqual([]);
      expect(v2Result.data.tasks[0].reference_files).toEqual([]);

      expect(v2Result.data.tasks[1].permitted_areas).toEqual([]);
      expect(v2Result.data.tasks[1].may_extend).toEqual([]);
      expect(v2Result.data.tasks[1].non_goals).toEqual([]);
      expect(v2Result.data.tasks[1].reference_files).toEqual([]);

      expect(v2Result.data.tasks[2].expected_files).toEqual([]);
      expect(v2Result.data.tasks[2].permitted_areas).toEqual([]);
      expect(v2Result.data.tasks[2].may_extend).toEqual([]);
      expect(v2Result.data.tasks[2].non_goals).toEqual([]);
      expect(v2Result.data.tasks[2].reference_files).toEqual([]);
    }
  });

  it('parses legacy V1 manifests without scope fields', () => {
    const v1Manifest = {
      version: 1,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Legacy V1 task',
          files: ['packages/core/src/service.ts'],
        },
      ],
    };

    const v1Result = taskManifestV1Schema.safeParse(v1Manifest);
    expect(v1Result.success).toBe(true);

    const unifiedV1Result = taskManifestSchema.safeParse(v1Manifest);
    expect(unifiedV1Result.success).toBe(true);
  });

  it('rejects absolute root traversal and empty scope paths', () => {
    const invalidSegments = [
      { path: '', reason: 'empty string' },
      { path: '   ', reason: 'whitespace string' },
      { path: '/absolute/path.ts', reason: 'absolute POSIX path' },
      { path: '/root', reason: 'root POSIX path' },
      { path: '\\windows\\path', reason: 'absolute Windows path' },
      { path: 'packages\\core\\src\\index.ts', reason: 'backslash separator' },
      { path: '../escape.ts', reason: 'dot-dot parent traversal' },
      { path: 'packages/../escape.ts', reason: 'inline dot-dot traversal' },
      { path: './packages/core/src/index.ts', reason: 'leading dot-slash' },
      { path: '.', reason: 'single dot path' },
      { path: 'packages//core//src', reason: 'duplicate slashes' },
      { path: 'packages/core/src/', reason: 'trailing slash' },
    ];

    const fields: Array<
      'expected_files' | 'permitted_areas' | 'may_extend' | 'non_goals' | 'reference_files'
    > = ['expected_files', 'permitted_areas', 'may_extend', 'non_goals', 'reference_files'];

    for (const field of fields) {
      for (const { path: invalidPath, reason } of invalidSegments) {
        const manifest = {
          version: 2,
          task_count: 1,
          tasks: [
            {
              n: 1,
              title: `Invalid path in ${field} due to ${reason}`,
              [field]: [invalidPath],
            },
          ],
        };

        const result = taskManifestV2Schema.safeParse(manifest);
        expect(
          result.success,
          `Expected taskManifestV2Schema to reject ${reason} ${invalidPath} in ${field}`,
        ).toBe(false);

        if (!result.success) {
          const fieldIssue = result.error.issues.find(
            (issue) => issue.path[0] === 'tasks' && issue.path[1] === 0 && issue.path[2] === field,
          );
          expect(
            fieldIssue,
            `Expected issue path to identify offending task field [tasks, 0, ${field}], got: ${JSON.stringify(
              result.error.issues,
            )}`,
          ).toBeDefined();
        }
      }
    }
  });

  it('rejects reference_files overlap with expected_files', () => {
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Overlapping reference and expected files',
          expected_files: ['packages/core/src/service.ts'],
          reference_files: ['packages/core/src/service.ts'],
        },
      ],
    };

    const result = taskManifestV2Schema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) =>
          i.path[0] === 'tasks' &&
          i.path[1] === 0 &&
          (i.path[2] === 'reference_files' || i.path[2] === 'expected_files'),
      );
      expect(issue).toBeDefined();
      expect(['reference_files', 'expected_files']).toContain(issue?.path[2]);
    }

    const legacyManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Overlapping reference and legacy files',
          files: ['packages/core/src/service.ts'],
          reference_files: ['packages/core/src/service.ts'],
        },
      ],
    };

    const legacyResult = taskManifestV2Schema.safeParse(legacyManifest);
    expect(legacyResult.success).toBe(false);
    if (!legacyResult.success) {
      const issue = legacyResult.error.issues.find(
        (i) =>
          i.path[0] === 'tasks' &&
          i.path[1] === 0 &&
          (i.path[2] === 'reference_files' || i.path[2] === 'files'),
      );
      expect(issue).toBeDefined();
      expect(['reference_files', 'files']).toContain(issue?.path[2]);
    }
  });

  it('rejects reference_files overlap with may_extend', () => {
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Overlapping reference and may_extend files',
          expected_files: ['packages/core/src/service.ts'],
          may_extend: ['packages/core/src/utils.ts'],
          reference_files: ['packages/core/src/utils.ts'],
        },
      ],
    };

    const result = taskManifestV2Schema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) =>
          i.path[0] === 'tasks' &&
          i.path[1] === 0 &&
          (i.path[2] === 'reference_files' || i.path[2] === 'may_extend'),
      );
      expect(issue).toBeDefined();
      expect(['reference_files', 'may_extend']).toContain(issue?.path[2]);
    }
  });

  it('rejects may_extend overlap with expected_files', () => {
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Overlapping expected_files and may_extend',
          expected_files: ['packages/core/src/service.ts'],
          may_extend: ['packages/core/src/service.ts'],
        },
      ],
    };

    const result = taskManifestV2Schema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) =>
          i.path[0] === 'tasks' &&
          i.path[1] === 0 &&
          (i.path[2] === 'may_extend' || i.path[2] === 'expected_files'),
      );
      expect(issue).toBeDefined();
      expect(['may_extend', 'expected_files']).toContain(issue?.path[2]);
    }

    const legacyManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Overlapping legacy files and may_extend',
          files: ['packages/core/src/service.ts'],
          may_extend: ['packages/core/src/service.ts'],
        },
      ],
    };

    const legacyResult = taskManifestV2Schema.safeParse(legacyManifest);
    expect(legacyResult.success).toBe(false);
    if (!legacyResult.success) {
      const issue = legacyResult.error.issues.find(
        (i) =>
          i.path[0] === 'tasks' &&
          i.path[1] === 0 &&
          (i.path[2] === 'may_extend' || i.path[2] === 'files'),
      );
      expect(issue).toBeDefined();
      expect(['may_extend', 'files']).toContain(issue?.path[2]);
    }
  });

  it('rejects non_goals overlap with expected_files or may_extend', () => {
    const expectedOverlapManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'non_goals exact overlap with expected_files',
          expected_files: ['packages/core/src/service.ts'],
          non_goals: ['packages/core/src/service.ts'],
        },
      ],
    };

    const expectedResult = taskManifestV2Schema.safeParse(expectedOverlapManifest);
    expect(expectedResult.success).toBe(false);
    if (!expectedResult.success) {
      const issue = expectedResult.error.issues.find(
        (i) =>
          i.path[0] === 'tasks' &&
          i.path[1] === 0 &&
          (i.path[2] === 'non_goals' || i.path[2] === 'expected_files'),
      );
      expect(issue).toBeDefined();
      expect(['non_goals', 'expected_files']).toContain(issue?.path[2]);
    }

    const mayExtendOverlapManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'non_goals exact overlap with may_extend',
          expected_files: ['packages/core/src/service.ts'],
          may_extend: ['packages/core/src/utils.ts'],
          non_goals: ['packages/core/src/utils.ts'],
        },
      ],
    };

    const mayExtendResult = taskManifestV2Schema.safeParse(mayExtendOverlapManifest);
    expect(mayExtendResult.success).toBe(false);
    if (!mayExtendResult.success) {
      const issue = mayExtendResult.error.issues.find(
        (i) =>
          i.path[0] === 'tasks' &&
          i.path[1] === 0 &&
          (i.path[2] === 'non_goals' || i.path[2] === 'may_extend'),
      );
      expect(issue).toBeDefined();
      expect(['non_goals', 'may_extend']).toContain(issue?.path[2]);
    }

    const directoryPrefixManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'non_goals directory prefix of expected_files',
          expected_files: ['packages/infrastructure/src/db.ts'],
          non_goals: ['packages/infrastructure'],
        },
      ],
    };

    const prefixResult = taskManifestV2Schema.safeParse(directoryPrefixManifest);
    expect(prefixResult.success).toBe(false);
    if (!prefixResult.success) {
      const issue = prefixResult.error.issues.find(
        (i) =>
          i.path[0] === 'tasks' &&
          i.path[1] === 0 &&
          (i.path[2] === 'non_goals' || i.path[2] === 'expected_files'),
      );
      expect(issue).toBeDefined();
      expect(['non_goals', 'expected_files']).toContain(issue?.path[2]);
    }

    const directoryPrefixMayExtendManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'non_goals directory prefix of may_extend',
          expected_files: ['packages/core/src/service.ts'],
          may_extend: ['packages/infrastructure/src/db.ts'],
          non_goals: ['packages/infrastructure'],
        },
      ],
    };

    const prefixMayExtendResult = taskManifestV2Schema.safeParse(directoryPrefixMayExtendManifest);
    expect(prefixMayExtendResult.success).toBe(false);
    if (!prefixMayExtendResult.success) {
      const issue = prefixMayExtendResult.error.issues.find(
        (i) =>
          i.path[0] === 'tasks' &&
          i.path[1] === 0 &&
          (i.path[2] === 'non_goals' || i.path[2] === 'may_extend'),
      );
      expect(issue).toBeDefined();
      expect(['non_goals', 'may_extend']).toContain(issue?.path[2]);
    }
  });

  it('rejects non_goals overlap with permitted_areas', () => {
    const exactOverlapManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'non_goals exact overlap with permitted_areas',
          expected_files: ['packages/core/src/service.ts'],
          permitted_areas: ['packages/core/src'],
          non_goals: ['packages/core/src'],
        },
      ],
    };

    const exactResult = taskManifestV2Schema.safeParse(exactOverlapManifest);
    expect(exactResult.success).toBe(false);
    if (!exactResult.success) {
      const issue = exactResult.error.issues.find(
        (i) =>
          i.path[0] === 'tasks' &&
          i.path[1] === 0 &&
          (i.path[2] === 'non_goals' || i.path[2] === 'permitted_areas'),
      );
      expect(issue).toBeDefined();
      expect(['non_goals', 'permitted_areas']).toContain(issue?.path[2]);
    }

    const directoryOverlapManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'non_goals directory ancestor of permitted_areas',
          expected_files: ['packages/application/src/service.ts'],
          permitted_areas: ['packages/core/src'],
          non_goals: ['packages/core'],
        },
      ],
    };

    const directoryResult = taskManifestV2Schema.safeParse(directoryOverlapManifest);
    expect(directoryResult.success).toBe(false);
    if (!directoryResult.success) {
      const issue = directoryResult.error.issues.find(
        (i) =>
          i.path[0] === 'tasks' &&
          i.path[1] === 0 &&
          (i.path[2] === 'non_goals' || i.path[2] === 'permitted_areas'),
      );
      expect(issue).toBeDefined();
      expect(['non_goals', 'permitted_areas']).toContain(issue?.path[2]);
    }
  });

  it('allows sibling paths that share string prefixes but distinct path segments', () => {
    // Note: permitted_areas provides additive directory permission and does not restrict
    // expected_files or may_extend. Each field below exercises distinct sibling segments against non_goals.
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Sibling directories with shared prefix',
          expected_files: ['packages/application/src/file.ts'],
          permitted_areas: ['packages/app-other/src'],
          may_extend: ['packages/app-utils/src/helper.ts'],
          non_goals: ['packages/app'],
          reference_files: ['packages/app-docs/README.md'],
        },
      ],
    };

    const result = taskManifestV2Schema.safeParse(manifest);
    expect(result.success).toBe(true);
  });
});

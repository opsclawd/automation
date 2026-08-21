import { describe, expect, it } from 'vitest';
import {
  taskManifestSchema,
  taskManifestV1Schema,
  taskManifestV2Schema,
} from '../task-manifest.js';

describe('taskManifestV2Schema scope contract', () => {
  it('accepts canonical scope declarations and defaults omitted or null fields to empty arrays', () => {
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

    const omittedAndNullManifest = {
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

    const omittedResult = taskManifestV2Schema.safeParse(omittedAndNullManifest);
    expect(omittedResult.success).toBe(true);
    if (omittedResult.success) {
      expect(omittedResult.data.tasks[0].permitted_areas).toEqual([]);
      expect(omittedResult.data.tasks[0].may_extend).toEqual([]);
      expect(omittedResult.data.tasks[0].non_goals).toEqual([]);
      expect(omittedResult.data.tasks[0].reference_files).toEqual([]);

      expect(omittedResult.data.tasks[1].permitted_areas).toEqual([]);
      expect(omittedResult.data.tasks[1].may_extend).toEqual([]);
      expect(omittedResult.data.tasks[1].non_goals).toEqual([]);
      expect(omittedResult.data.tasks[1].reference_files).toEqual([]);

      expect(omittedResult.data.tasks[2].expected_files).toEqual([]);
      expect(omittedResult.data.tasks[2].permitted_areas).toEqual([]);
      expect(omittedResult.data.tasks[2].may_extend).toEqual([]);
      expect(omittedResult.data.tasks[2].non_goals).toEqual([]);
      expect(omittedResult.data.tasks[2].reference_files).toEqual([]);
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

  it('rejects absolute dot-segment backslash duplicate-slash and trailing-slash scope paths', () => {
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

  it('rejects reference may-extend expected permitted-area and non-goal overlaps by path segment', () => {
    // 1. reference_files overlap with expected_files
    const refExpectedManifest = {
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
    expect(taskManifestV2Schema.safeParse(refExpectedManifest).success).toBe(false);

    // 2. reference_files overlap with legacy files
    const refLegacyManifest = {
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
    expect(taskManifestV2Schema.safeParse(refLegacyManifest).success).toBe(false);

    // 3. reference_files overlap with may_extend
    const refMayExtendManifest = {
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
    expect(taskManifestV2Schema.safeParse(refMayExtendManifest).success).toBe(false);

    // 4. may_extend overlap with expected_files
    const mayExtendExpectedManifest = {
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
    expect(taskManifestV2Schema.safeParse(mayExtendExpectedManifest).success).toBe(false);

    // 5. non_goals exact overlap with expected_files
    const ngExpectedManifest = {
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
    expect(taskManifestV2Schema.safeParse(ngExpectedManifest).success).toBe(false);

    // 6. non_goals exact overlap with may_extend
    const ngMayExtendManifest = {
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
    expect(taskManifestV2Schema.safeParse(ngMayExtendManifest).success).toBe(false);

    // 7. non_goals directory prefix of expected_files
    const ngPrefixExpectedManifest = {
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
    expect(taskManifestV2Schema.safeParse(ngPrefixExpectedManifest).success).toBe(false);

    // 8. non_goals directory prefix of may_extend
    const ngPrefixMayExtendManifest = {
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
    expect(taskManifestV2Schema.safeParse(ngPrefixMayExtendManifest).success).toBe(false);

    // 9. non_goals exact overlap with permitted_areas
    const ngPermittedExactManifest = {
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
    expect(taskManifestV2Schema.safeParse(ngPermittedExactManifest).success).toBe(false);

    // 10. non_goals directory ancestor of permitted_areas
    const ngAncestorPermittedManifest = {
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
    expect(taskManifestV2Schema.safeParse(ngAncestorPermittedManifest).success).toBe(false);

    // 11. permitted_areas directory ancestor of non_goals
    const permittedAncestorNgManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'permitted_areas directory ancestor of non_goals',
          expected_files: ['packages/application/src/service.ts'],
          permitted_areas: ['packages/core'],
          non_goals: ['packages/core/src'],
        },
      ],
    };
    expect(taskManifestV2Schema.safeParse(permittedAncestorNgManifest).success).toBe(false);

    // 12. distinct sibling paths are allowed
    const siblingManifest = {
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
    expect(taskManifestV2Schema.safeParse(siblingManifest).success).toBe(true);
  });
});

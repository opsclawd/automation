import { describe, expect, it } from 'vitest';
import { checkTaskBoundaries, resolveEffectiveTaskScope } from '../task-file-boundaries.js';

describe('resolveEffectiveTaskScope', () => {
  it('derives only immediate non-root parents and keeps root required files exact-only', () => {
    const task = {
      n: 1,
      title: 'Core service implementation',
      expected_files: [
        'packages/core/src/service.ts',
        'packages/core/src/index.ts',
        'package.json',
        'README.md',
      ],
    };

    const scope = resolveEffectiveTaskScope(task);
    expect(scope.requiredFiles).toEqual([
      'packages/core/src/service.ts',
      'packages/core/src/index.ts',
      'package.json',
      'README.md',
    ]);
    expect(scope.permittedAreas).toEqual(['packages/core/src']);
    expect(scope.mayExtendFiles).toEqual([]);
    expect(scope.nonGoals).toEqual([]);
    expect(scope.referenceFiles).toEqual([]);
  });

  it('merges V1 files and older V2 expected_files into required files with safe derived areas', () => {
    const mergedTask = {
      n: 1,
      title: 'Merged legacy and V2 task',
      expected_files: ['packages/core/src/new.ts', 'packages/other/src/file.ts'],
      files: ['packages/core/src/legacy.ts', 'packages/core/src/new.ts'],
    };

    const mergedScope = resolveEffectiveTaskScope(mergedTask);
    expect(mergedScope.requiredFiles).toEqual([
      'packages/core/src/new.ts',
      'packages/other/src/file.ts',
      'packages/core/src/legacy.ts',
    ]);
    expect(mergedScope.permittedAreas).toEqual(['packages/core/src', 'packages/other/src']);

    const v1Task = {
      n: 1,
      title: 'Pure V1 task',
      files: ['packages/application/src/ports.ts'],
    };
    const v1Scope = resolveEffectiveTaskScope(v1Task);
    expect(v1Scope.requiredFiles).toEqual(['packages/application/src/ports.ts']);
    expect(v1Scope.permittedAreas).toEqual(['packages/application/src']);
  });

  it('resolves an empty task without explicit permission as read-only', () => {
    const emptyTask = {
      n: 1,
      title: 'Empty task with no files',
    };
    const scope = resolveEffectiveTaskScope(emptyTask);
    expect(scope).toEqual({
      requiredFiles: [],
      mayExtendFiles: [],
      permittedAreas: [],
      nonGoals: [],
      referenceFiles: [],
    });

    const explicitEmptyTask = {
      n: 2,
      title: 'Explicit empty arrays',
      expected_files: [],
      permitted_areas: [],
      may_extend: [],
      non_goals: [],
      reference_files: [],
    };
    const explicitScope = resolveEffectiveTaskScope(explicitEmptyTask);
    expect(explicitScope).toEqual({
      requiredFiles: [],
      mayExtendFiles: [],
      permittedAreas: [],
      nonGoals: [],
      referenceFiles: [],
    });
  });

  it('normalizes and deduplicates defensive in-memory inputs', () => {
    const dirtyTask = {
      n: 1,
      title: 'Dirty inputs',
      expected_files: [
        '  packages\\core\\src\\service.ts  ',
        './packages/core/src/service.ts',
        'packages/core/src/index.ts',
      ],
      permitted_areas: ['  packages\\core\\src  ', './packages/core/test'],
      may_extend: ['  packages\\application\\src\\ports.ts  ', 'packages/application/src/ports.ts'],
      non_goals: ['  packages\\infrastructure\\src  '],
      reference_files: ['  packages\\domain\\src\\entity.ts  '],
    };

    const scope = resolveEffectiveTaskScope(dirtyTask);
    expect(scope.requiredFiles).toEqual([
      'packages/core/src/service.ts',
      'packages/core/src/index.ts',
    ]);
    expect(scope.permittedAreas).toEqual(['packages/core/src', 'packages/core/test']);
    expect(scope.mayExtendFiles).toEqual(['packages/application/src/ports.ts']);
    expect(scope.nonGoals).toEqual(['packages/infrastructure/src']);
    expect(scope.referenceFiles).toEqual(['packages/domain/src/entity.ts']);
  });

  it('handles explicit extra permitted areas and optional may_extend files', () => {
    const task = {
      n: 1,
      title: 'Explicit areas and may extend',
      expected_files: ['packages/core/src/service.ts'],
      permitted_areas: ['packages/core/test', 'packages/core/src'],
      may_extend: ['packages/application/src/ports.ts'],
      non_goals: ['packages/infrastructure'],
      reference_files: ['docs/adr/0010.md'],
    };

    const scope = resolveEffectiveTaskScope(task);
    expect(scope.requiredFiles).toEqual(['packages/core/src/service.ts']);
    // derived 'packages/core/src' + explicit 'packages/core/test', deduplicated
    expect(scope.permittedAreas).toEqual(['packages/core/src', 'packages/core/test']);
    expect(scope.mayExtendFiles).toEqual(['packages/application/src/ports.ts']);
    expect(scope.nonGoals).toEqual(['packages/infrastructure']);
    expect(scope.referenceFiles).toEqual(['docs/adr/0010.md']);
  });

  it('handles non-object and null inputs gracefully', () => {
    expect(resolveEffectiveTaskScope(null)).toEqual({
      requiredFiles: [],
      mayExtendFiles: [],
      permittedAreas: [],
      nonGoals: [],
      referenceFiles: [],
    });
    expect(resolveEffectiveTaskScope(undefined)).toEqual({
      requiredFiles: [],
      mayExtendFiles: [],
      permittedAreas: [],
      nonGoals: [],
      referenceFiles: [],
    });
    expect(resolveEffectiveTaskScope('not-a-task')).toEqual({
      requiredFiles: [],
      mayExtendFiles: [],
      permittedAreas: [],
      nonGoals: [],
      referenceFiles: [],
    });
  });
});

describe('checkTaskBoundaries with V2 effective scope', () => {
  it('permits files within permitted_areas and may_extend while rejecting files outside', () => {
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'V2 scope test task',
          expected_files: ['packages/core/src/service.ts'],
          permitted_areas: ['packages/core/test', 'packages/shared'],
          may_extend: ['packages/application/src/ports.ts'],
          reference_files: ['packages/domain/src/entity.ts'],
          non_goals: ['packages/shared/deprecated'],
        },
      ],
    };

    const committed = [
      'packages/core/src/service.ts', // required -> permitted
      'packages/core/src/sibling.ts', // derived area (packages/core/src) -> permitted
      'packages/core/test/service.test.ts', // explicit permitted_areas -> permitted
      'packages/shared/utils.ts', // explicit permitted_areas -> permitted
      'packages/application/src/ports.ts', // exact may_extend -> permitted
      'packages/domain/src/entity.ts', // reference_files -> modifiedReferenceFiles
      'packages/shared/deprecated/old.ts', // non_goals -> undeclaredFiles
      'packages/application/src/other.ts', // outside may_extend exact match -> undeclaredFiles
      'packages/infrastructure/src/db.ts', // undeclared -> undeclaredFiles
    ];

    const result = checkTaskBoundaries(committed, manifest);
    expect(result.modifiedReferenceFiles).toEqual(['packages/domain/src/entity.ts']);
    expect(result.undeclaredFiles).toEqual([
      'packages/application/src/other.ts',
      'packages/infrastructure/src/db.ts',
      'packages/shared/deprecated/old.ts',
    ]);
  });
});

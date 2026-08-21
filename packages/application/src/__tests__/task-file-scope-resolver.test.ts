import { describe, expect, it } from 'vitest';
import {
  declaredTaskFiles,
  referenceTaskFiles,
  resolveEffectiveTaskScope,
} from '../task-file-boundaries.js';

describe('resolveEffectiveTaskScope', () => {
  it('derives only immediate non-root parents and keeps root required files exact-only', () => {
    const task = {
      n: 1,
      title: 'Nested and root deliverables',
      expected_files: [
        'packages/core/src/service.ts',
        'packages/core/index.ts',
        'README.md',
        'package.json',
      ],
    };

    const scope = resolveEffectiveTaskScope(task);

    expect(scope.requiredFiles).toEqual([
      'packages/core/src/service.ts',
      'packages/core/index.ts',
      'README.md',
      'package.json',
    ]);
    expect(scope.permittedAreas).toEqual(['packages/core/src', 'packages/core']);
    expect(scope.permittedAreas).not.toContain('.');
    expect(scope.permittedAreas).not.toContain('');
    expect(scope.mayExtendFiles).toEqual([]);
    expect(scope.nonGoals).toEqual([]);
    expect(scope.referenceFiles).toEqual([]);
  });

  it('merges V1 files and older V2 expected_files into required files with safe derived areas', () => {
    const v1AndV2Task = {
      n: 1,
      title: 'Merged task files',
      expected_files: ['packages/application/src/service.ts', 'packages/application/src/legacy.ts'],
      files: ['packages/application/src/legacy.ts', 'packages/application/src/extra.ts'],
    };

    const scope = resolveEffectiveTaskScope(v1AndV2Task);

    expect(scope.requiredFiles).toEqual([
      'packages/application/src/service.ts',
      'packages/application/src/legacy.ts',
      'packages/application/src/extra.ts',
    ]);
    expect(scope.permittedAreas).toEqual(['packages/application/src']);
    expect(scope.mayExtendFiles).toEqual([]);
    expect(scope.nonGoals).toEqual([]);
    expect(scope.referenceFiles).toEqual([]);

    const pureV1Task = {
      n: 2,
      title: 'Pure V1 Task',
      files: ['src/index.ts', 'package.json'],
    };

    const v1Scope = resolveEffectiveTaskScope(pureV1Task);
    expect(v1Scope.requiredFiles).toEqual(['src/index.ts', 'package.json']);
    expect(v1Scope.permittedAreas).toEqual(['src']);
    expect(v1Scope.mayExtendFiles).toEqual([]);
    expect(v1Scope.nonGoals).toEqual([]);
    expect(v1Scope.referenceFiles).toEqual([]);
  });

  it('resolves an empty task without explicit permission as read-only', () => {
    const emptyTask = {
      n: 1,
      title: 'Read-only / empty task',
      expected_files: [],
    };

    const scope = resolveEffectiveTaskScope(emptyTask);

    expect(scope.requiredFiles).toEqual([]);
    expect(scope.mayExtendFiles).toEqual([]);
    expect(scope.permittedAreas).toEqual([]);
    expect(scope.nonGoals).toEqual([]);
    expect(scope.referenceFiles).toEqual([]);

    const omittedTask = {
      n: 2,
      title: 'Omitted task fields',
    };

    const omittedScope = resolveEffectiveTaskScope(omittedTask);
    expect(omittedScope.requiredFiles).toEqual([]);
    expect(omittedScope.mayExtendFiles).toEqual([]);
    expect(omittedScope.permittedAreas).toEqual([]);
    expect(omittedScope.nonGoals).toEqual([]);
    expect(omittedScope.referenceFiles).toEqual([]);
  });

  it('normalizes and deduplicates in-memory inputs defensively', () => {
    const messyTask = {
      n: 1,
      title: 'Messy in-memory inputs',
      expected_files: [
        '  packages/core/src/service.ts  ',
        './packages/core/src/service.ts',
        'packages\\core\\src\\service.ts',
        'packages/core/src/other.ts',
        '',
        '   ',
      ],
      may_extend: [
        'packages/core/src/helper.ts',
        ' ./packages/core/src/helper.ts ',
        'packages\\core\\src\\helper.ts',
      ],
      permitted_areas: [
        'packages/core/extra/',
        './packages/core/extra',
        'packages//deep//area',
        'packages\\windows\\area',
      ],
      non_goals: ['packages/blocked/', './packages/blocked', 'packages\\blocked'],
      reference_files: ['packages/domain/src/entity.ts', ' ./packages/domain/src/entity.ts '],
    };

    const scope = resolveEffectiveTaskScope(messyTask);

    expect(scope.requiredFiles).toEqual([
      'packages/core/src/service.ts',
      'packages/core/src/other.ts',
    ]);
    expect(scope.mayExtendFiles).toEqual(['packages/core/src/helper.ts']);
    expect(scope.permittedAreas).toEqual([
      'packages/core/src',
      'packages/core/extra',
      'packages/deep/area',
      'packages/windows/area',
    ]);
    expect(scope.nonGoals).toEqual(['packages/blocked']);
    expect(scope.referenceFiles).toEqual(['packages/domain/src/entity.ts']);
  });

  it('combines derived areas with explicit permitted areas without duplicates', () => {
    const task = {
      n: 1,
      title: 'Derived and explicit permitted areas',
      expected_files: ['packages/core/src/service.ts'],
      permitted_areas: ['packages/core/src', 'packages/core/test', 'packages/shared'],
    };

    const scope = resolveEffectiveTaskScope(task);

    expect(scope.permittedAreas).toEqual([
      'packages/core/src',
      'packages/core/test',
      'packages/shared',
    ]);
  });

  it('handles null undefined and non-object inputs safely', () => {
    const nullScope = resolveEffectiveTaskScope(null);
    expect(nullScope).toEqual({
      requiredFiles: [],
      mayExtendFiles: [],
      permittedAreas: [],
      nonGoals: [],
      referenceFiles: [],
    });

    const undefinedScope = resolveEffectiveTaskScope(undefined);
    expect(undefinedScope).toEqual({
      requiredFiles: [],
      mayExtendFiles: [],
      permittedAreas: [],
      nonGoals: [],
      referenceFiles: [],
    });

    const stringScope = resolveEffectiveTaskScope('not a task');
    expect(stringScope).toEqual({
      requiredFiles: [],
      mayExtendFiles: [],
      permittedAreas: [],
      nonGoals: [],
      referenceFiles: [],
    });

    const numberScope = resolveEffectiveTaskScope(42);
    expect(numberScope).toEqual({
      requiredFiles: [],
      mayExtendFiles: [],
      permittedAreas: [],
      nonGoals: [],
      referenceFiles: [],
    });
  });

  it('preserves declaredTaskFiles and referenceTaskFiles helper compatibility', () => {
    const task = {
      n: 1,
      title: 'Helper compatibility check',
      expected_files: ['packages/core/src/service.ts'],
      files: ['packages/core/src/legacy.ts'],
      reference_files: ['packages/domain/src/entity.ts'],
    };

    expect(declaredTaskFiles(task)).toEqual([
      'packages/core/src/service.ts',
      'packages/core/src/legacy.ts',
    ]);
    expect(referenceTaskFiles(task)).toEqual(['packages/domain/src/entity.ts']);
  });

  it('handles older V2 tasks omitting newer scope fields', () => {
    const olderV2Task = {
      n: 1,
      title: 'Older V2 Task',
      expected_files: ['packages/core/src/service.ts'],
    };

    const scope = resolveEffectiveTaskScope(olderV2Task);
    expect(scope.requiredFiles).toEqual(['packages/core/src/service.ts']);
    expect(scope.permittedAreas).toEqual(['packages/core/src']);
    expect(scope.mayExtendFiles).toEqual([]);
    expect(scope.nonGoals).toEqual([]);
    expect(scope.referenceFiles).toEqual([]);
  });
});

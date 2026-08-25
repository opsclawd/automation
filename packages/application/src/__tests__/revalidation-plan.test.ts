import { describe, it, expect } from 'vitest';
import type { ValidationCommand } from '../ports/validation-port.js';
import { planRevalidation, type WorkspacePackageDescriptor } from '../revalidation-plan.js';

describe('Revalidation Scope Planner', () => {
  const standardDescriptors: WorkspacePackageDescriptor[] = [
    {
      name: '@ai-sdlc/shared',
      directory: 'packages/shared',
      workspaceDependencies: [],
    },
    {
      name: '@ai-sdlc/domain',
      directory: 'packages/domain',
      workspaceDependencies: ['@ai-sdlc/shared'],
    },
    {
      name: '@ai-sdlc/application',
      directory: 'packages/application',
      workspaceDependencies: ['@ai-sdlc/domain', '@ai-sdlc/shared'],
    },
    {
      name: '@ai-sdlc/infrastructure',
      directory: 'packages/infrastructure',
      workspaceDependencies: ['@ai-sdlc/application', '@ai-sdlc/domain', '@ai-sdlc/shared'],
    },
    {
      name: '@ai-sdlc/api',
      directory: 'apps/api',
      workspaceDependencies: [
        '@ai-sdlc/application',
        '@ai-sdlc/domain',
        '@ai-sdlc/infrastructure',
        '@ai-sdlc/shared',
      ],
    },
    {
      name: '@ai-sdlc/cli',
      directory: 'apps/cli',
      workspaceDependencies: [
        '@ai-sdlc/api',
        '@ai-sdlc/application',
        '@ai-sdlc/domain',
        '@ai-sdlc/infrastructure',
        '@ai-sdlc/shared',
      ],
    },
    {
      name: '@ai-sdlc/web',
      directory: 'apps/web',
      workspaceDependencies: [],
    },
  ];

  const standardCommands: ValidationCommand[] = [
    'pnpm build',
    'pnpm lint',
    'pnpm typecheck',
    'pnpm test',
    'pnpm test:bash',
    'pnpm boundaries',
  ];

  const standardTiers: string[][] = [
    ['pnpm build'],
    ['pnpm lint', 'pnpm typecheck', 'pnpm test', 'pnpm test:bash', 'pnpm boundaries'],
  ];

  it('application change includes every transitive dependent', () => {
    const result = planRevalidation({
      changedPaths: ['packages/application/src/revalidation-plan.ts'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: standardDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });

    expect(result.mode).toBe('narrow');
    if (result.mode === 'narrow') {
      expect(result.changedPackage).toBe('@ai-sdlc/application');
      expect(result.narrowedPackages).toEqual([
        '@ai-sdlc/application',
        '@ai-sdlc/infrastructure',
        '@ai-sdlc/api',
        '@ai-sdlc/cli',
      ]);
      expect(result.commands).toEqual([
        'pnpm --filter "...@ai-sdlc/application" build',
        'pnpm exec eslint packages/application packages/infrastructure apps/api apps/cli --max-warnings=0',
        'pnpm --filter "...@ai-sdlc/application" typecheck',
        'pnpm --filter "...@ai-sdlc/application" test',
        'pnpm boundaries',
      ]);
      expect(result.tiers).toEqual([
        ['pnpm --filter "...@ai-sdlc/application" build'],
        [
          'pnpm exec eslint packages/application packages/infrastructure apps/api apps/cli --max-warnings=0',
          'pnpm --filter "...@ai-sdlc/application" typecheck',
          'pnpm --filter "...@ai-sdlc/application" test',
          'pnpm boundaries',
        ],
      ]);
    }
  });

  it('infrastructure and api changes resolve their complete dependent closures', () => {
    const infraResult = planRevalidation({
      changedPaths: ['packages/infrastructure/src/index.ts'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: standardDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });

    expect(infraResult.mode).toBe('narrow');
    if (infraResult.mode === 'narrow') {
      expect(infraResult.changedPackage).toBe('@ai-sdlc/infrastructure');
      expect(infraResult.narrowedPackages).toEqual([
        '@ai-sdlc/infrastructure',
        '@ai-sdlc/api',
        '@ai-sdlc/cli',
      ]);
      expect(infraResult.commands).toEqual([
        'pnpm --filter "...@ai-sdlc/infrastructure" build',
        'pnpm exec eslint packages/infrastructure apps/api apps/cli --max-warnings=0',
        'pnpm --filter "...@ai-sdlc/infrastructure" typecheck',
        'pnpm --filter "...@ai-sdlc/infrastructure" test',
        'pnpm boundaries',
      ]);
    }

    const apiResult = planRevalidation({
      changedPaths: ['apps/api/src/compose.ts'],
      iterationIndex: 3,
      hasStepBaseline: true,
      descriptors: standardDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });

    expect(apiResult.mode).toBe('narrow');
    if (apiResult.mode === 'narrow') {
      expect(apiResult.changedPackage).toBe('@ai-sdlc/api');
      expect(apiResult.narrowedPackages).toEqual(['@ai-sdlc/api', '@ai-sdlc/cli']);
      expect(apiResult.commands).toEqual([
        'pnpm --filter "...@ai-sdlc/api" build',
        'pnpm exec eslint apps/api apps/cli --max-warnings=0',
        'pnpm --filter "...@ai-sdlc/api" typecheck',
        'pnpm --filter "...@ai-sdlc/api" test',
        'pnpm boundaries',
      ]);
    }
  });

  it('leaf cli and web changes use a single-package filter', () => {
    const cliResult = planRevalidation({
      changedPaths: ['apps/cli/src/cli.ts'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: standardDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });

    expect(cliResult.mode).toBe('narrow');
    if (cliResult.mode === 'narrow') {
      expect(cliResult.changedPackage).toBe('@ai-sdlc/cli');
      expect(cliResult.narrowedPackages).toEqual(['@ai-sdlc/cli']);
      expect(cliResult.commands).toEqual([
        'pnpm --filter @ai-sdlc/cli build',
        'pnpm exec eslint apps/cli --max-warnings=0',
        'pnpm --filter @ai-sdlc/cli typecheck',
        'pnpm --filter @ai-sdlc/cli test',
        'pnpm boundaries',
      ]);
    }

    const webResult = planRevalidation({
      changedPaths: ['apps/web/src/app.tsx'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: standardDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });

    expect(webResult.mode).toBe('narrow');
    if (webResult.mode === 'narrow') {
      expect(webResult.changedPackage).toBe('@ai-sdlc/web');
      expect(webResult.narrowedPackages).toEqual(['@ai-sdlc/web']);
      expect(webResult.commands).toEqual([
        'pnpm --filter @ai-sdlc/web build',
        'pnpm exec eslint apps/web --max-warnings=0',
        'pnpm --filter @ai-sdlc/web typecheck',
        'pnpm --filter @ai-sdlc/web test',
        'pnpm boundaries',
      ]);
    }
  });

  it('first iteration or missing baseline remains full', () => {
    const firstIterationResult = planRevalidation({
      changedPaths: ['packages/application/src/foo.ts'],
      iterationIndex: 1,
      hasStepBaseline: true,
      descriptors: standardDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });

    expect(firstIterationResult).toEqual({
      mode: 'full',
      reason: 'first_iteration',
      commands: standardCommands,
      tiers: standardTiers,
    });

    const noBaselineResult = planRevalidation({
      changedPaths: ['packages/application/src/foo.ts'],
      iterationIndex: 2,
      hasStepBaseline: false,
      descriptors: standardDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });

    expect(noBaselineResult).toEqual({
      mode: 'full',
      reason: 'missing_baseline',
      commands: standardCommands,
      tiers: standardTiers,
    });
  });

  it('empty multi-package upstream and outside-package changes remain full', () => {
    // Empty paths
    const emptyResult = planRevalidation({
      changedPaths: [],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: standardDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });
    expect(emptyResult).toEqual({
      mode: 'full',
      reason: 'empty_changed_files',
      commands: standardCommands,
      tiers: standardTiers,
    });

    // Multiple packages
    const multiResult = planRevalidation({
      changedPaths: ['packages/application/src/foo.ts', 'packages/infrastructure/src/bar.ts'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: standardDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });
    expect(multiResult).toEqual({
      mode: 'full',
      reason: 'multiple_packages',
      commands: standardCommands,
      tiers: standardTiers,
    });

    // Upstream package: @ai-sdlc/shared
    const sharedResult = planRevalidation({
      changedPaths: ['packages/shared/src/index.ts'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: standardDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });
    expect(sharedResult).toEqual({
      mode: 'full',
      reason: 'upstream_package',
      commands: standardCommands,
      tiers: standardTiers,
    });

    // Upstream package: @ai-sdlc/domain
    const domainResult = planRevalidation({
      changedPaths: ['packages/domain/src/index.ts'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: standardDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });
    expect(domainResult).toEqual({
      mode: 'full',
      reason: 'upstream_package',
      commands: standardCommands,
      tiers: standardTiers,
    });

    // Outside-package root file
    const rootFileResult = planRevalidation({
      changedPaths: ['README.md'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: standardDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });
    expect(rootFileResult).toEqual({
      mode: 'full',
      reason: 'outside_package',
      commands: standardCommands,
      tiers: standardTiers,
    });

    // Outside-package scripts
    const scriptsResult = planRevalidation({
      changedPaths: ['scripts/run.sh'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: standardDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });
    expect(scriptsResult).toEqual({
      mode: 'full',
      reason: 'outside_package',
      commands: standardCommands,
      tiers: standardTiers,
    });

    // Package change + root file
    const mixedResult = planRevalidation({
      changedPaths: ['packages/application/src/foo.ts', '.github/workflows/ci.yml'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: standardDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });
    expect(mixedResult).toEqual({
      mode: 'full',
      reason: 'outside_package',
      commands: standardCommands,
      tiers: standardTiers,
    });
  });

  it('invalid ambiguous cyclic or unresolved workspace metadata remains full', () => {
    // Duplicate directory
    const dupDirDescriptors: WorkspacePackageDescriptor[] = [
      { name: 'pkg-a', directory: 'packages/a', workspaceDependencies: [] },
      { name: 'pkg-b', directory: 'packages/a', workspaceDependencies: [] },
    ];
    const dupDirResult = planRevalidation({
      changedPaths: ['packages/a/src/index.ts'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: dupDirDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });
    expect(dupDirResult).toEqual({
      mode: 'full',
      reason: 'ambiguous_ownership',
      commands: standardCommands,
      tiers: standardTiers,
    });

    // Duplicate package name
    const dupNameDescriptors: WorkspacePackageDescriptor[] = [
      { name: 'pkg-a', directory: 'packages/a', workspaceDependencies: [] },
      { name: 'pkg-a', directory: 'packages/b', workspaceDependencies: [] },
    ];
    const dupNameResult = planRevalidation({
      changedPaths: ['packages/a/src/index.ts'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: dupNameDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });
    expect(dupNameResult).toEqual({
      mode: 'full',
      reason: 'ambiguous_ownership',
      commands: standardCommands,
      tiers: standardTiers,
    });

    // Unresolved workspace dependency
    const unresolvedDescriptors: WorkspacePackageDescriptor[] = [
      { name: 'pkg-a', directory: 'packages/a', workspaceDependencies: ['missing-pkg'] },
    ];
    const unresolvedResult = planRevalidation({
      changedPaths: ['packages/a/src/index.ts'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: unresolvedDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });
    expect(unresolvedResult).toEqual({
      mode: 'full',
      reason: 'unresolved_dependency',
      commands: standardCommands,
      tiers: standardTiers,
    });

    // Cyclic dependency
    const cyclicDescriptors: WorkspacePackageDescriptor[] = [
      { name: 'pkg-a', directory: 'packages/a', workspaceDependencies: ['pkg-b'] },
      { name: 'pkg-b', directory: 'packages/b', workspaceDependencies: ['pkg-a'] },
    ];
    const cyclicResult = planRevalidation({
      changedPaths: ['packages/a/src/index.ts'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: cyclicDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });
    expect(cyclicResult).toEqual({
      mode: 'full',
      reason: 'cyclic_dependency',
      commands: standardCommands,
      tiers: standardTiers,
    });

    // Invalid package name (unsafe shell characters)
    const invalidNameDescriptors: WorkspacePackageDescriptor[] = [
      { name: 'pkg; rm -rf /', directory: 'packages/a', workspaceDependencies: [] },
    ];
    const invalidNameResult = planRevalidation({
      changedPaths: ['packages/a/src/index.ts'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: invalidNameDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });
    expect(invalidNameResult).toEqual({
      mode: 'full',
      reason: 'invalid_descriptor',
      commands: standardCommands,
      tiers: standardTiers,
    });

    // Invalid escaping directory
    const escapingDescriptors: WorkspacePackageDescriptor[] = [
      { name: 'pkg-a', directory: '../outside', workspaceDependencies: [] },
    ];
    const escapingResult = planRevalidation({
      changedPaths: ['packages/application/src/index.ts'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: escapingDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });
    expect(escapingResult).toEqual({
      mode: 'full',
      reason: 'invalid_descriptor',
      commands: standardCommands,
      tiers: standardTiers,
    });
  });

  it('narrow commands preserve all safety gates', () => {
    // 1. Array-based commands and with Bats files present
    const descriptorsWithBats: WorkspacePackageDescriptor[] = standardDescriptors.map((desc) =>
      desc.name === '@ai-sdlc/infrastructure' ? { ...desc, hasBats: true } : desc,
    );

    const resultWithBats = planRevalidation({
      changedPaths: ['packages/application/src/index.ts'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: descriptorsWithBats,
      commands: [
        'pnpm -r build',
        'pnpm lint',
        'pnpm -r typecheck',
        'pnpm -r test',
        'pnpm test:bash',
        'pnpm boundaries',
      ],
      tiers: [
        ['pnpm -r build'],
        ['pnpm lint', 'pnpm -r typecheck', 'pnpm -r test', 'pnpm test:bash', 'pnpm boundaries'],
      ],
    });

    expect(resultWithBats.mode).toBe('narrow');
    if (resultWithBats.mode === 'narrow') {
      expect(resultWithBats.commands).toEqual([
        'pnpm --filter "...@ai-sdlc/application" build',
        'pnpm exec eslint packages/application packages/infrastructure apps/api apps/cli --max-warnings=0',
        'pnpm --filter "...@ai-sdlc/application" typecheck',
        'pnpm --filter "...@ai-sdlc/application" test',
        'pnpm test:bash',
        'pnpm boundaries',
      ]);
      expect(resultWithBats.tiers).toEqual([
        ['pnpm --filter "...@ai-sdlc/application" build'],
        [
          'pnpm exec eslint packages/application packages/infrastructure apps/api apps/cli --max-warnings=0',
          'pnpm --filter "...@ai-sdlc/application" typecheck',
          'pnpm --filter "...@ai-sdlc/application" test',
          'pnpm test:bash',
          'pnpm boundaries',
        ],
      ]);
    }

    // 2. Array command shapes (string[])
    const arrayCommands: ValidationCommand[] = [
      ['pnpm', 'build'],
      ['pnpm', 'lint'],
      ['pnpm', 'typecheck'],
      ['pnpm', 'test'],
      ['pnpm', 'boundaries'],
    ];
    const arrayResult = planRevalidation({
      changedPaths: ['apps/cli/src/main.ts'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: standardDescriptors,
      commands: arrayCommands,
    });

    expect(arrayResult.mode).toBe('narrow');
    if (arrayResult.mode === 'narrow') {
      expect(arrayResult.commands).toEqual([
        ['pnpm', '--filter', '@ai-sdlc/cli', 'build'],
        ['pnpm', 'exec', 'eslint', 'apps/cli', '--max-warnings=0'],
        ['pnpm', '--filter', '@ai-sdlc/cli', 'typecheck'],
        ['pnpm', '--filter', '@ai-sdlc/cli', 'test'],
        ['pnpm', 'boundaries'],
      ]);
    }
  });

  it('narrow tiers contain only effective commands', () => {
    const customTiers: string[][] = [
      ['pnpm build'],
      ['pnpm test:bash'],
      ['pnpm lint', 'pnpm typecheck', 'pnpm test', 'pnpm boundaries'],
    ];

    const result = planRevalidation({
      changedPaths: ['apps/cli/src/main.ts'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: standardDescriptors,
      commands: standardCommands,
      tiers: customTiers,
    });

    expect(result.mode).toBe('narrow');
    if (result.mode === 'narrow') {
      // test:bash tier should be omitted because no Bats files exist in cli closure
      expect(result.tiers).toEqual([
        ['pnpm --filter @ai-sdlc/cli build'],
        [
          'pnpm exec eslint apps/cli --max-warnings=0',
          'pnpm --filter @ai-sdlc/cli typecheck',
          'pnpm --filter @ai-sdlc/cli test',
          'pnpm boundaries',
        ],
      ]);
      // Verify no full commands leak through
      for (const tier of result.tiers ?? []) {
        for (const cmd of tier) {
          expect(cmd).not.toBe('pnpm build');
          expect(cmd).not.toBe('pnpm lint');
          expect(cmd).not.toBe('pnpm typecheck');
          expect(cmd).not.toBe('pnpm test');
          expect(cmd).not.toBe('pnpm test:bash');
        }
      }
    }
  });

  it('unknown configured commands fail closed', () => {
    const unknownCommandsResult = planRevalidation({
      changedPaths: ['packages/application/src/index.ts'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: standardDescriptors,
      commands: ['pnpm build', 'pnpm lint', 'docker run custom-validator'],
    });

    expect(unknownCommandsResult).toEqual({
      mode: 'full',
      reason: 'unknown_command',
      commands: ['pnpm build', 'pnpm lint', 'docker run custom-validator'],
      tiers: undefined,
    });
  });

  it('planner output ordering is deterministic', () => {
    // Reverse descriptor order
    const reversedDescriptors = [...standardDescriptors].reverse();
    // Permuted changed paths
    const permutedPaths = [
      'packages/application/src/z.ts',
      'packages/application/src/a.ts',
      'packages/application/src/m.ts',
    ];

    const plan1 = planRevalidation({
      changedPaths: permutedPaths,
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: standardDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });

    const plan2 = planRevalidation({
      changedPaths: [...permutedPaths].reverse(),
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: reversedDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });

    expect(plan1).toEqual(plan2);
    expect(plan1.mode).toBe('narrow');
    if (plan1.mode === 'narrow' && plan2.mode === 'narrow') {
      expect(plan1.narrowedPackages).toEqual(plan2.narrowedPackages);
      expect(plan1.commands).toEqual(plan2.commands);
      expect(plan1.tiers).toEqual(plan2.tiers);
    }
  });
});

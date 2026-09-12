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
        'pnpm --filter ...@ai-sdlc/application build',
        'pnpm exec eslint packages/application packages/infrastructure apps/api apps/cli --max-warnings=0',
        'pnpm --filter ...@ai-sdlc/application typecheck',
        'pnpm --filter ...@ai-sdlc/application test',
        'pnpm boundaries',
      ]);
      expect(result.tiers).toEqual([
        ['pnpm --filter ...@ai-sdlc/application build'],
        [
          'pnpm exec eslint packages/application packages/infrastructure apps/api apps/cli --max-warnings=0',
          'pnpm --filter ...@ai-sdlc/application typecheck',
          'pnpm --filter ...@ai-sdlc/application test',
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
        'pnpm --filter ...@ai-sdlc/infrastructure build',
        'pnpm exec eslint packages/infrastructure apps/api apps/cli --max-warnings=0',
        'pnpm --filter ...@ai-sdlc/infrastructure typecheck',
        'pnpm --filter ...@ai-sdlc/infrastructure test',
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
        'pnpm --filter ...@ai-sdlc/api build',
        'pnpm exec eslint apps/api apps/cli --max-warnings=0',
        'pnpm --filter ...@ai-sdlc/api typecheck',
        'pnpm --filter ...@ai-sdlc/api test',
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

  it('pr-ready iteration forces full validation', () => {
    const prReadyResult = planRevalidation({
      changedPaths: ['packages/application/src/foo.ts'],
      iterationIndex: 2,
      hasStepBaseline: true,
      isPrReady: true,
      descriptors: standardDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });

    expect(prReadyResult).toEqual({
      mode: 'full',
      reason: 'pr_ready',
      commands: standardCommands,
      tiers: standardTiers,
    });
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

  it('duplicate entries in workspaceDependencies do not falsely detect cycles', () => {
    const dupDepsDescriptors: WorkspacePackageDescriptor[] = [
      { name: 'pkg-a', directory: 'packages/a', workspaceDependencies: [] },
      { name: 'pkg-b', directory: 'packages/b', workspaceDependencies: ['pkg-a', 'pkg-a'] },
      {
        name: 'pkg-c',
        directory: 'packages/c',
        workspaceDependencies: ['pkg-b', 'pkg-b', 'pkg-a'],
      },
    ];
    const result = planRevalidation({
      changedPaths: ['packages/b/src/index.ts'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: dupDepsDescriptors,
      commands: standardCommands,
      tiers: standardTiers,
    });

    expect(result.mode).toBe('narrow');
    if (result.mode === 'narrow') {
      expect(result.changedPackage).toBe('pkg-b');
      expect(result.narrowedPackages).toEqual(['pkg-b', 'pkg-c']);
    }
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
        'pnpm --filter ...@ai-sdlc/application build',
        'pnpm exec eslint packages/application packages/infrastructure apps/api apps/cli --max-warnings=0',
        'pnpm --filter ...@ai-sdlc/application typecheck',
        'pnpm --filter ...@ai-sdlc/application test',
        'pnpm test:bash',
        'pnpm boundaries',
      ]);
      expect(resultWithBats.tiers).toEqual([
        ['pnpm --filter ...@ai-sdlc/application build'],
        [
          'pnpm exec eslint packages/application packages/infrastructure apps/api apps/cli --max-warnings=0',
          'pnpm --filter ...@ai-sdlc/application typecheck',
          'pnpm --filter ...@ai-sdlc/application test',
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

    // 3. Array command shapes for non-leaf packages (no literal quotes in filter)
    const nonLeafArrayResult = planRevalidation({
      changedPaths: ['packages/application/src/index.ts'],
      iterationIndex: 2,
      hasStepBaseline: true,
      descriptors: standardDescriptors,
      commands: arrayCommands,
    });

    expect(nonLeafArrayResult.mode).toBe('narrow');
    if (nonLeafArrayResult.mode === 'narrow') {
      expect(nonLeafArrayResult.commands).toEqual([
        ['pnpm', '--filter', '...@ai-sdlc/application', 'build'],
        [
          'pnpm',
          'exec',
          'eslint',
          'packages/application',
          'packages/infrastructure',
          'apps/api',
          'apps/cli',
          '--max-warnings=0',
        ],
        ['pnpm', '--filter', '...@ai-sdlc/application', 'typecheck'],
        ['pnpm', '--filter', '...@ai-sdlc/application', 'test'],
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

  describe('custom command scopes (#1207)', () => {
    it('includes scoped custom command when changed file intersects declared path prefix', () => {
      const plan = planRevalidation({
        changedPaths: ['packages/infrastructure/src/ffmpeg/transcoder.ts'],
        iterationIndex: 2,
        hasStepBaseline: true,
        descriptors: standardDescriptors,
        commands: ['pnpm build', 'pnpm test:assembly', 'pnpm test:db'],
        commandScopes: {
          'pnpm test:assembly': ['packages/infrastructure/src/ffmpeg'],
          'pnpm test:db': ['packages/infrastructure/src/db'],
        },
      });

      expect(plan.mode).toBe('narrow');
      if (plan.mode === 'narrow') {
        expect(plan.changedPackage).toBe('@ai-sdlc/infrastructure');
        expect(plan.commands).toEqual([
          'pnpm --filter ...@ai-sdlc/infrastructure build',
          'pnpm test:assembly',
        ]);
      }
    });

    it('skips scoped custom command when changed file does not intersect declared path prefix', () => {
      const plan = planRevalidation({
        changedPaths: ['packages/infrastructure/src/db/migrations.ts'],
        iterationIndex: 2,
        hasStepBaseline: true,
        descriptors: standardDescriptors,
        commands: ['pnpm build', 'pnpm test:assembly', 'pnpm test:db'],
        commandScopes: {
          'pnpm test:assembly': ['packages/infrastructure/src/ffmpeg'],
          'pnpm test:db': ['packages/infrastructure/src/db'],
        },
      });

      expect(plan.mode).toBe('narrow');
      if (plan.mode === 'narrow') {
        expect(plan.commands).toEqual([
          'pnpm --filter ...@ai-sdlc/infrastructure build',
          'pnpm test:db',
        ]);
      }
    });

    it('resolves declared package name in scope and matches package directory', () => {
      const plan = planRevalidation({
        changedPaths: ['packages/infrastructure/src/foo.ts'],
        iterationIndex: 2,
        hasStepBaseline: true,
        descriptors: standardDescriptors,
        commands: ['pnpm build', 'pnpm test:infra', 'pnpm test:api'],
        commandScopes: {
          'pnpm test:infra': ['@ai-sdlc/infrastructure'],
          'pnpm test:api': ['@ai-sdlc/api'],
        },
      });

      expect(plan.mode).toBe('narrow');
      if (plan.mode === 'narrow') {
        expect(plan.commands).toEqual([
          'pnpm --filter ...@ai-sdlc/infrastructure build',
          'pnpm test:infra',
        ]);
      }
    });

    it('matches when any declared scope in the array intersects (OR logic)', () => {
      const plan = planRevalidation({
        changedPaths: ['packages/infrastructure/src/audio/piper.ts'],
        iterationIndex: 2,
        hasStepBaseline: true,
        descriptors: standardDescriptors,
        commands: ['pnpm build', 'pnpm test:audio'],
        commandScopes: {
          'pnpm test:audio': [
            'packages/infrastructure/src/audio/kokoro.ts',
            'packages/infrastructure/src/audio/piper.ts',
          ],
        },
      });

      expect(plan.mode).toBe('narrow');
      if (plan.mode === 'narrow') {
        expect(plan.commands).toEqual([
          'pnpm --filter ...@ai-sdlc/infrastructure build',
          'pnpm test:audio',
        ]);
      }
    });

    it('falls back to full validation if an unrecognized command has no declared scope', () => {
      const plan = planRevalidation({
        changedPaths: ['packages/infrastructure/src/ffmpeg/transcoder.ts'],
        iterationIndex: 2,
        hasStepBaseline: true,
        descriptors: standardDescriptors,
        commands: ['pnpm build', 'pnpm test:assembly', 'pnpm test:unscoped-custom'],
        commandScopes: {
          'pnpm test:assembly': ['packages/infrastructure/src/ffmpeg'],
        },
      });

      expect(plan).toEqual({
        mode: 'full',
        reason: 'unknown_command',
        commands: ['pnpm build', 'pnpm test:assembly', 'pnpm test:unscoped-custom'],
        tiers: undefined,
      });
    });

    it('supports array format validation commands with scopes', () => {
      const plan = planRevalidation({
        changedPaths: ['packages/infrastructure/src/ffmpeg/worker.ts'],
        iterationIndex: 2,
        hasStepBaseline: true,
        descriptors: standardDescriptors,
        commands: [['pnpm', 'test:assembly']],
        commandScopes: {
          'pnpm test:assembly': ['packages/infrastructure/src/ffmpeg'],
        },
      });

      expect(plan.mode).toBe('narrow');
      if (plan.mode === 'narrow') {
        expect(plan.commands).toEqual([['pnpm', 'test:assembly']]);
      }
    });

    it('rewrites tiers and drops skipped commands and empty tiers', () => {
      const plan = planRevalidation({
        changedPaths: ['packages/infrastructure/src/ffmpeg/worker.ts'],
        iterationIndex: 2,
        hasStepBaseline: true,
        descriptors: standardDescriptors,
        commands: ['pnpm build', 'pnpm test:db', 'pnpm test:assembly'],
        tiers: [['pnpm build'], ['pnpm test:db'], ['pnpm test:assembly']],
        commandScopes: {
          'pnpm test:assembly': ['packages/infrastructure/src/ffmpeg'],
          'pnpm test:db': ['packages/infrastructure/src/db'],
        },
      });

      expect(plan.mode).toBe('narrow');
      if (plan.mode === 'narrow') {
        expect(plan.commands).toEqual([
          'pnpm --filter ...@ai-sdlc/infrastructure build',
          'pnpm test:assembly',
        ]);
        expect(plan.tiers).toEqual([
          ['pnpm --filter ...@ai-sdlc/infrastructure build'],
          // Tier 2 (['pnpm test:db']) was completely dropped because test:db was skipped
          ['pnpm test:assembly'],
        ]);
      }
    });

    it('falls back to full mode with empty_narrowed_commands when all commands are skipped', () => {
      const plan = planRevalidation({
        changedPaths: ['packages/infrastructure/src/other/something.ts'],
        iterationIndex: 2,
        hasStepBaseline: true,
        descriptors: standardDescriptors,
        commands: ['pnpm test:assembly', 'pnpm test:db'],
        commandScopes: {
          'pnpm test:assembly': ['packages/infrastructure/src/ffmpeg'],
          'pnpm test:db': ['packages/infrastructure/src/db'],
        },
      });

      expect(plan).toEqual({
        mode: 'full',
        reason: 'empty_narrowed_commands',
        commands: ['pnpm test:assembly', 'pnpm test:db'],
        tiers: undefined,
      });
    });

    it('preserves conservative gates over declared scopes', () => {
      // First iteration must remain full
      const firstIter = planRevalidation({
        changedPaths: ['packages/infrastructure/src/ffmpeg/transcoder.ts'],
        iterationIndex: 1,
        hasStepBaseline: true,
        descriptors: standardDescriptors,
        commands: ['pnpm test:assembly'],
        commandScopes: {
          'pnpm test:assembly': ['packages/infrastructure/src/ffmpeg'],
        },
      });
      expect(firstIter.mode).toBe('full');
      if (firstIter.mode === 'full') {
        expect(firstIter.reason).toBe('first_iteration');
      }

      // PR-ready must remain full
      const prReady = planRevalidation({
        changedPaths: ['packages/infrastructure/src/ffmpeg/transcoder.ts'],
        iterationIndex: 2,
        hasStepBaseline: true,
        isPrReady: true,
        descriptors: standardDescriptors,
        commands: ['pnpm test:assembly'],
        commandScopes: {
          'pnpm test:assembly': ['packages/infrastructure/src/ffmpeg'],
        },
      });
      expect(prReady.mode).toBe('full');
      if (prReady.mode === 'full') {
        expect(prReady.reason).toBe('pr_ready');
      }

      // Changes spanning multiple packages must remain full
      const multiPkg = planRevalidation({
        changedPaths: [
          'packages/infrastructure/src/ffmpeg/transcoder.ts',
          'apps/api/src/compose.ts',
        ],
        iterationIndex: 2,
        hasStepBaseline: true,
        descriptors: standardDescriptors,
        commands: ['pnpm test:assembly'],
        commandScopes: {
          'pnpm test:assembly': ['packages/infrastructure/src/ffmpeg'],
        },
      });
      expect(multiPkg.mode).toBe('full');
      if (multiPkg.mode === 'full') {
        expect(multiPkg.reason).toBe('multiple_packages');
      }

      // Upstream shared package change must remain full
      const upstreamPkg = planRevalidation({
        changedPaths: ['packages/shared/src/index.ts'],
        iterationIndex: 2,
        hasStepBaseline: true,
        descriptors: standardDescriptors,
        commands: ['pnpm test:assembly'],
        commandScopes: {
          'pnpm test:assembly': ['packages/infrastructure/src/ffmpeg'],
        },
      });
      expect(upstreamPkg.mode).toBe('full');
      if (upstreamPkg.mode === 'full') {
        expect(upstreamPkg.reason).toBe('upstream_package');
      }
    });

    it('narrows correctly in the comfy-content-orchestrator scenario (#1207)', () => {
      const comfyDescriptors: WorkspacePackageDescriptor[] = [
        {
          name: '@comfy/core',
          directory: 'packages/core',
          workspaceDependencies: [],
        },
        {
          name: '@comfy/infrastructure',
          directory: 'packages/infrastructure',
          workspaceDependencies: ['@comfy/core'],
        },
      ];

      const comfyCommands = [
        'pnpm preValidation',
        'pnpm check:hooks',
        'pnpm format',
        'pnpm test:db',
        'pnpm test:assembly',
        'pnpm test:kokoro',
        'pnpm test:piper',
        'pnpm test:ltx-production',
        'pnpm test:whisperx',
        'pnpm install --frozen-lockfile',
        'pnpm check:control-plane',
      ];

      const comfyScopes = {
        'pnpm preValidation': ['packages'],
        'pnpm check:hooks': ['scripts', 'packages'],
        'pnpm format': ['packages'],
        'pnpm test:db': ['packages/infrastructure/src/db'],
        'pnpm test:assembly': ['packages/infrastructure/src/ffmpeg'],
        'pnpm test:kokoro': ['packages/infrastructure/src/audio/kokoro'],
        'pnpm test:piper': ['packages/infrastructure/src/audio/piper'],
        'pnpm test:ltx-production': ['packages/infrastructure/src/video/ltx'],
        'pnpm test:whisperx': ['packages/infrastructure/src/audio/whisperx'],
        'pnpm install --frozen-lockfile': ['packages'],
        'pnpm check:control-plane': ['packages/core'],
      };

      // When only an ffmpeg transcoder file in infrastructure is touched
      const result = planRevalidation({
        changedPaths: ['packages/infrastructure/src/ffmpeg/transcoder.ts'],
        iterationIndex: 2,
        hasStepBaseline: true,
        descriptors: comfyDescriptors,
        commands: comfyCommands,
        commandScopes: comfyScopes,
      });

      expect(result.mode).toBe('narrow');
      if (result.mode === 'narrow') {
        expect(result.changedPackage).toBe('@comfy/infrastructure');
        // Only packages-scoped repo checks and test:assembly should run
        expect(result.commands).toEqual([
          'pnpm preValidation',
          'pnpm check:hooks',
          'pnpm format',
          'pnpm test:assembly',
          'pnpm install --frozen-lockfile',
        ]);
        // Expensive suites test:db (298s avg), test:kokoro, test:piper, test:ltx, test:whisperx are skipped!
        expect(result.commands).not.toContain('pnpm test:db');
        expect(result.commands).not.toContain('pnpm test:kokoro');
        expect(result.commands).not.toContain('pnpm test:piper');
        expect(result.commands).not.toContain('pnpm test:ltx-production');
        expect(result.commands).not.toContain('pnpm test:whisperx');
        expect(result.commands).not.toContain('pnpm check:control-plane');
      }
    });
  });
});

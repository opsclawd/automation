import { describe, expect, it } from 'vitest';
import {
  buildTargetedTestCommand,
  buildTaskValidationCommands,
  checkRedTaskValidationParity,
  checkTaskValidationCommandsDeclarationMismatch,
  checkTaskValidationCommandsDoubleInversion,
  checkTaskValidationCommandsSatisfiability,
  evaluateRevalidationWithInvertedCommands,
  expandTaskValidationCommandsWithNewTests,
  extractFailedTestFilesFromOutput,
  extractTargetTestFilesFromInvertedCommands,
  globToRegex,
  isNegatedValidationCommand,
  isPathMatchedByExpectedTarget,
  isTestFileCoveredByCommands,
  parseRunnerConfigExclusions,
  stripNegationPrefix,
} from '../task-validation-commands.js';
import type { TaskManifest } from '../phases/index.js';

import type { ValidationCommand } from '../ports/validation-port.js';

interface ManifestWithOptions {
  commands?: ValidationCommand[];
  expectedFiles?: string[];
  legacyFiles?: string[];
}

function manifestWith(options: ManifestWithOptions): TaskManifest {
  return {
    version: 2,
    tasks: [
      {
        n: 1,
        title: 'Task 1',
        description: 'Desc',
        files: options.legacyFiles ?? [],
        expected_files: options.expectedFiles ?? [],
        validation_commands: options.commands ?? [],
      },
    ],
  };
}

function manifestWithCommands(commands: ValidationCommand[]): TaskManifest {
  return manifestWith({ commands });
}

describe('buildTaskValidationCommands', () => {
  it('drops bare workspace and package-wide commands as redundant with global validation', () => {
    const commands = [
      'pnpm test',
      'pnpm --filter @ai-sdlc/application typecheck',
      'typecheck',
      'pnpm lint',
      'eslint .',
      'pnpm vitest run',
      'vitest run',
    ];

    expect(buildTaskValidationCommands(manifestWithCommands(commands), 1)).toEqual([]);
  });

  it('preserves targeted per-file vitest, eslint, git diff, and custom commands', () => {
    const commands = [
      'vitest run "src/foo.test.ts"',
      "vitest run 'src/foo.spec.tsx' --reporter=verbose",
      'pnpm vitest run src/foo.test.mts',
      'pnpm exec vitest run src/foo.spec.cts',
      'pnpm --filter @ai-sdlc/application exec vitest run src/foo.test.ts',
      'pnpm exec eslint apps/app/app/position/[id].tsx --max-warnings=0',
      'git diff --check -- src/foo.test.ts',
      'DATABASE_URL=x vitest run src/foo.test.ts',
      '! pnpm vitest run src/foo.test.ts',
      'pnpm check-custom',
    ];

    const result = buildTaskValidationCommands(manifestWithCommands(commands), 1);
    expect(result).toEqual([
      'vitest run "src/foo.test.ts" --passWithNoTests=false',
      "vitest run 'src/foo.spec.tsx' --reporter=verbose --passWithNoTests=false",
      'pnpm vitest run src/foo.test.mts --passWithNoTests=false',
      'pnpm exec vitest run src/foo.spec.cts --passWithNoTests=false',
      'pnpm --filter @ai-sdlc/application exec vitest run src/foo.test.ts',
      'pnpm exec eslint apps/app/app/position/[id].tsx --max-warnings=0',
      'git diff --check -- src/foo.test.ts',
      'DATABASE_URL=x vitest run src/foo.test.ts',
      '! pnpm vitest run src/foo.test.ts',
      'pnpm check-custom',
    ]);
  });

  it('selects non-redundant commands by manifest version and returns none for an absent task', () => {
    const v1Manifest: TaskManifest = {
      version: 1,
      tasks: [
        {
          n: 1,
          title: 'V1 Task',
          description: 'Desc',
          files: [],
          validation: [
            'git diff --check -- src/v1.test.ts',
            'vitest run src/v1.test.ts',
            'pnpm test',
          ],
        },
      ],
    };

    const v2Manifest: TaskManifest = {
      version: 2,
      tasks: [
        {
          n: 1,
          title: 'V2 Task',
          description: 'Desc',
          files: [],
          expected_files: [],
          validation_commands: ['git diff --check -- src/v2.test.ts', 'pnpm typecheck'],
        },
      ],
    };

    expect(buildTaskValidationCommands(v1Manifest, 1)).toEqual([
      'git diff --check -- src/v1.test.ts',
      'vitest run src/v1.test.ts --passWithNoTests=false',
    ]);
    expect(buildTaskValidationCommands(v2Manifest, 1)).toEqual([
      'git diff --check -- src/v2.test.ts',
    ]);
    expect(buildTaskValidationCommands(v2Manifest, 999)).toEqual([]);
  });

  it('targeted per-file vitest validation commands survive deduplication with passWithNoTests flag', () => {
    const manifest: TaskManifest = {
      version: 1,
      tasks: [
        {
          n: 1,
          title: 'Targeted Task',
          description: 'Desc',
          files: [],
          validation: ['pnpm vitest run src/foo.test.ts'],
        },
      ],
    };

    expect(buildTaskValidationCommands(manifest, 1)).toEqual([
      'pnpm vitest run src/foo.test.ts --passWithNoTests=false',
    ]);
  });

  it('declared drizzle SQL migrations receive leading existence guards', () => {
    const manifest = manifestWith({
      expectedFiles: [
        'drizzle/0001_root.sql',
        'packages/adapters/drizzle/0002_execution_origin.sql',
      ],
      commands: ['git diff --check'],
    });

    const result = buildTaskValidationCommands(manifest, 1);
    expect(result).toEqual([
      "test -f 'drizzle/0001_root.sql' || { printf '%s\\n' 'Required migration file was never created: drizzle/0001_root.sql' >&2; exit 1; }",
      "test -f 'packages/adapters/drizzle/0002_execution_origin.sql' || { printf '%s\\n' 'Required migration file was never created: packages/adapters/drizzle/0002_execution_origin.sql' >&2; exit 1; }",
      'git diff --check',
    ]);
  });

  it('non-migration expected files do not receive existence guards', () => {
    const manifest = manifestWith({
      expectedFiles: [
        'packages/adapters/src/schema.ts',
        'packages/adapters/sql/0001_not_drizzle.sql',
        'packages/adapters/drizzle/meta.json',
      ],
      commands: ['git diff --check'],
    });

    expect(buildTaskValidationCommands(manifest, 1)).toEqual(['git diff --check']);
  });

  it('migration guards are deduplicated and shell quoted', () => {
    const migration = "packages/adapter's/drizzle/0003_$unsafe.sql";
    const manifest = manifestWith({
      expectedFiles: [migration],
      legacyFiles: [migration],
      commands: [],
    });

    const result = buildTaskValidationCommands(manifest, 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("packages/adapter'\\''s/drizzle/0003_$unsafe.sql");
    expect(result[0]).toContain('Required migration file was never created:');
    expect(result[0]).toContain('>&2');
    expect(result[0]).toContain('exit 1');
  });

  it('legacy manifest files receive drizzle migration guards', () => {
    const v1Manifest: TaskManifest = {
      version: 1,
      tasks: [
        {
          n: 1,
          title: 'V1 Task',
          description: 'Desc',
          files: ['drizzle/0001_v1.sql'],
          validation: ['git diff --check'],
        },
      ],
    };

    const result = buildTaskValidationCommands(v1Manifest, 1);
    expect(result).toEqual([
      "test -f 'drizzle/0001_v1.sql' || { printf '%s\\n' 'Required migration file was never created: drizzle/0001_v1.sql' >&2; exit 1; }",
      'git diff --check',
    ]);
  });

  it('drops bare argv validation commands but preserves targeted argv commands', () => {
    const bareCommands: ValidationCommand[] = [
      ['pnpm', 'test'],
      ['pnpm', '--filter', '@ai-sdlc/application', 'typecheck'],
      ['eslint', '.'],
      ['vitest', 'run'],
    ];

    expect(buildTaskValidationCommands(manifestWithCommands(bareCommands), 1)).toEqual([]);

    const targetedCommands: ValidationCommand[] = [
      ['vitest', 'run', 'src/foo.test.ts'],
      ['pnpm', 'vitest', 'run', 'src/foo.spec.tsx', '--reporter=verbose'],
      ['pnpm', 'exec', 'vitest', 'run', 'src/foo.test.mts', '--passWithNoTests'],
      ['npx', 'vitest', 'run', 'src/foo.test.js', '--passWithNoTests=true'],
      ['pnpm', 'exec', 'eslint', 'apps/app/app/position/[id].tsx'],
    ];

    expect(buildTaskValidationCommands(manifestWithCommands(targetedCommands), 1)).toEqual([
      ['vitest', 'run', 'src/foo.test.ts', '--passWithNoTests=false'],
      [
        'pnpm',
        'vitest',
        'run',
        'src/foo.spec.tsx',
        '--reporter=verbose',
        '--passWithNoTests=false',
      ],
      ['pnpm', 'exec', 'vitest', 'run', 'src/foo.test.mts', '--passWithNoTests=false'],
      ['npx', 'vitest', 'run', 'src/foo.test.js', '--passWithNoTests=false'],
      ['pnpm', 'exec', 'eslint', 'apps/app/app/position/[id].tsx'],
    ]);
  });

  it('preserves non-redundant argv validation commands', () => {
    const commands: ValidationCommand[] = [
      ['git', 'diff', '--check', '--', 'src/foo.test.ts'],
      ['pnpm', 'custom-tool', 'src/foo.test.ts'],
    ];

    expect(buildTaskValidationCommands(manifestWithCommands(commands), 1)).toEqual(commands);
  });

  it('preserves mixed validation command order while filtering redundant subset', () => {
    const manifest = manifestWith({
      expectedFiles: ['drizzle/0001_root.sql'],
      commands: [
        'git diff --check',
        ['pnpm', 'exec', 'eslint', 'apps/app/app/position/[id].tsx'],
        'pnpm typecheck',
        ['vitest', 'run', 'src/foo.test.ts'],
      ],
    });

    const result = buildTaskValidationCommands(manifest, 1);
    expect(result).toEqual([
      "test -f 'drizzle/0001_root.sql' || { printf '%s\\n' 'Required migration file was never created: drizzle/0001_root.sql' >&2; exit 1; }",
      'git diff --check',
      ['pnpm', 'exec', 'eslint', 'apps/app/app/position/[id].tsx'],
      ['vitest', 'run', 'src/foo.test.ts', '--passWithNoTests=false'],
    ]);
  });
});

describe('checkTaskValidationCommandsSatisfiability', () => {
  it('globToRegex correctly converts glob patterns to RegExp, including brace expansion', () => {
    const re1 = globToRegex('**/*.integration.test.ts');
    expect(
      re1.test('packages/infrastructure/src/postgres/baseline-schema.integration.test.ts'),
    ).toBe(true);
    expect(re1.test('src/foo.test.ts')).toBe(false);

    const re2 = globToRegex('packages/*/src/**/*.test.ts');
    expect(re2.test('packages/infrastructure/src/postgres/baseline-schema.test.ts')).toBe(true);

    const reBrace = globToRegex('**/*.{test,spec}.ts');
    expect(reBrace.test('src/foo.test.ts')).toBe(true);
    expect(reBrace.test('src/foo.spec.ts')).toBe(true);
    expect(reBrace.test('src/foo.other.ts')).toBe(false);
  });

  it('filters config files by invoked runner kind so jest.config does not pollute vitest', async () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1',
          validation_commands: ['pnpm vitest run src/foo.test.ts'],
        },
      ],
    };

    const vitestConfig = `
      export default defineConfig({
        test: {
          include: ["src/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts"],
        }
      });
    `;

    const jestConfig = `
      module.exports = {
        testPathIgnorePatterns: ["src/foo.test.ts"],
      };
    `;

    const diagnostic = await checkTaskValidationCommandsSatisfiability(manifest, {
      worktreeRoot: '/dummy/worktree',
      readWorktreeFile: async (path) => {
        if (path === 'vitest.config.ts') return vitestConfig;
        if (path === 'jest.config.js') return jestConfig;
        return null;
      },
    });

    expect(diagnostic).toBeNull();
  });

  it('parseRunnerConfigExclusions extracts include and exclude patterns', () => {
    const config = `
      export default defineConfig({
        test: {
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts", "**/node_modules/**", "**/dist/**"],
        }
      });
    `;
    const { include, exclude } = parseRunnerConfigExclusions(config);
    expect(include).toEqual(['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts']);
    expect(exclude).toEqual(['**/*.integration.test.ts', '**/node_modules/**', '**/dist/**']);
  });

  it('rejects a task validation command targeting a path excluded by runner config', async () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1',
          validation_commands: [
            'pnpm vitest run packages/infrastructure/src/postgres/baseline-schema.integration.test.ts',
          ],
        },
      ],
    };

    const vitestConfig = `
      export default defineConfig({
        test: {
          include: ["packages/*/src/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts"],
        }
      });
    `;

    const diagnostic = await checkTaskValidationCommandsSatisfiability(manifest, {
      worktreeRoot: '/dummy/worktree',
      readWorktreeFile: async (path) => (path === 'vitest.config.ts' ? vitestConfig : null),
    });

    expect(diagnostic).not.toBeNull();
    expect(diagnostic).toContain('Task 1: validation_command');
    expect(diagnostic).toContain('is unsatisfiable by construction');
    expect(diagnostic).toContain('baseline-schema.integration.test.ts');
  });

  it('accepts satisfiable commands matching runner config', async () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1',
          validation_commands: [
            'pnpm vitest run packages/infrastructure/src/postgres/baseline-schema.test.ts',
          ],
        },
      ],
    };

    const vitestConfig = `
      export default defineConfig({
        test: {
          include: ["packages/*/src/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts"],
        }
      });
    `;

    const diagnostic = await checkTaskValidationCommandsSatisfiability(manifest, {
      worktreeRoot: '/dummy/worktree',
      readWorktreeFile: async (path) => (path === 'vitest.config.ts' ? vitestConfig : null),
    });

    expect(diagnostic).toBeNull();
  });
});

describe('buildTargetedTestCommand and config exclusions', () => {
  it('selects sibling config file when default vitest config excludes target path', () => {
    const defaultVitestConfig = `
      export default defineConfig({
        test: {
          include: ["packages/*/src/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts"],
        }
      });
    `;

    const integrationVitestConfig = `
      export default defineConfig({
        test: {
          include: ["**/*.integration.test.ts"],
          exclude: [],
        }
      });
    `;

    const files: Record<string, string> = {
      'vitest.config.ts': defaultVitestConfig,
      'vitest.integration.config.ts': integrationVitestConfig,
    };

    const targetPath =
      'packages/infrastructure/src/postgres/audit-protections.integration.test.ts';

    const cmd = buildTargetedTestCommand(targetPath, ['pnpm test:db'], {
      readWorktreeFile: (rel) => files[rel] ?? null,
    });

    expect(cmd).not.toBeNull();
    expect(cmd).toBe(
      "pnpm vitest run 'packages/infrastructure/src/postgres/audit-protections.integration.test.ts' --config 'vitest.integration.config.ts' --passWithNoTests=false",
    );
  });

  it('produces diagnostic and returns null when no config matches the target path', () => {
    const defaultVitestConfig = `
      export default defineConfig({
        test: {
          include: ["packages/*/src/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts", "**/unmatched/**"],
        }
      });
    `;

    const files: Record<string, string> = {
      'vitest.config.ts': defaultVitestConfig,
    };

    const targetPath = 'packages/infrastructure/src/unmatched/test.integration.test.ts';
    const diagnostics: string[] = [];

    const cmd = buildTargetedTestCommand(targetPath, [], {
      readWorktreeFile: (rel) => files[rel] ?? null,
      diagnostics,
    });

    expect(cmd).toBeNull();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(
      'Targeted test command for "packages/infrastructure/src/unmatched/test.integration.test.ts" was suppressed',
    );
  });

  it('expandTaskValidationCommandsWithNewTests suppresses unmatched target commands and logs diagnostics', () => {
    const defaultVitestConfig = `
      export default defineConfig({
        test: {
          include: ["packages/*/src/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts"],
        }
      });
    `;

    const files: Record<string, string> = {
      'vitest.config.ts': defaultVitestConfig,
      'packages/infrastructure/src/postgres/audit-protections.integration.test.ts': 'test content',
    };

    const diagnostics: string[] = [];

    const result = expandTaskValidationCommandsWithNewTests({
      changedFiles: [
        'packages/infrastructure/src/postgres/audit-protections.integration.test.ts',
      ],
      existingCommands: ['pnpm vitest run src/unit.test.ts --passWithNoTests=false'],
      fileExists: (rel) => Boolean(files[rel]),
      readWorktreeFile: (rel) => files[rel] ?? null,
      diagnostics,
    });

    expect(result).toEqual(['pnpm vitest run src/unit.test.ts --passWithNoTests=false']);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('was suppressed');
  });
});

describe('expandTaskValidationCommandsWithNewTests', () => {
  it('detects covered and uncovered test files accurately with isTestFileCoveredByCommands', () => {
    const commands: ValidationCommand[] = [
      'git diff --check -- packages/infrastructure/src/git/existing.test.ts',
    ];

    expect(
      isTestFileCoveredByCommands('packages/infrastructure/src/git/existing.test.ts', commands),
    ).toBe(true);

    expect(
      isTestFileCoveredByCommands(
        'packages/infrastructure/src/git/delete-worktree-file.test.ts',
        commands,
      ),
    ).toBe(false);

    const generalCommands: ValidationCommand[] = ['pnpm test'];
    expect(
      isTestFileCoveredByCommands(
        'packages/infrastructure/src/git/delete-worktree-file.test.ts',
        generalCommands,
      ),
    ).toBe(true);
  });

  it('filters bare redundant commands while expanding targeted test execution for new tests', () => {
    const existingCommands: ValidationCommand[] = [
      'git diff --check -- packages/infrastructure/src/git/existing.test.ts',
      'pnpm vitest run packages/infrastructure/src/git/existing.test.ts --passWithNoTests=false',
      'pnpm exec eslint packages/infrastructure/src/git/existing.test.ts',
      'pnpm typecheck',
    ];

    const changedFiles = [
      'packages/infrastructure/src/git/delete-worktree-file.ts',
      'packages/infrastructure/src/git/__tests__/delete-worktree-file.test.ts',
    ];

    const existingFiles = new Set([
      'packages/infrastructure/src/git/delete-worktree-file.ts',
      'packages/infrastructure/src/git/__tests__/delete-worktree-file.test.ts',
    ]);

    const result = expandTaskValidationCommandsWithNewTests({
      changedFiles,
      existingCommands,
      fileExists: (p) => existingFiles.has(p),
    });

    expect(result).toEqual([
      'git diff --check -- packages/infrastructure/src/git/existing.test.ts',
      'pnpm vitest run packages/infrastructure/src/git/existing.test.ts --passWithNoTests=false',
      'pnpm exec eslint packages/infrastructure/src/git/existing.test.ts',
      "pnpm vitest run 'packages/infrastructure/src/git/__tests__/delete-worktree-file.test.ts' --passWithNoTests=false",
    ]);
  });

  it('does not duplicate targeted commands if already covered', () => {
    const existingCommands: ValidationCommand[] = [
      'pnpm vitest run packages/infrastructure/src/git/__tests__/delete-worktree-file.test.ts --passWithNoTests=false',
    ];

    const changedFiles = ['packages/infrastructure/src/git/__tests__/delete-worktree-file.test.ts'];

    const existingFiles = new Set([
      'packages/infrastructure/src/git/__tests__/delete-worktree-file.test.ts',
    ]);

    const result = expandTaskValidationCommandsWithNewTests({
      changedFiles,
      existingCommands,
      fileExists: (p) => existingFiles.has(p),
    });

    expect(result).toEqual(existingCommands);
  });
});

describe('checkTaskValidationCommandsDeclarationMismatch', () => {
  it('returns null for a v1 manifest (v1 has no reference_files / validation_commands)', () => {
    const manifest: TaskManifest = {
      version: 1,
      task_count: 1,
      tasks: [{ n: 1, title: 'task 1', files: ['f.ts'], validation: ['vitest run f.test.ts'] }],
    };

    expect(checkTaskValidationCommandsDeclarationMismatch(manifest)).toBeNull();
  });

  it('returns null when no validation_commands reference files declared as reference_files', () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 'task 1',
          expected_files: ['packages/foo/src/a.ts'],
          reference_files: ['packages/foo/src/existing.ts'],
        },
        {
          n: 2,
          title: 'task 2',
          expected_files: ['packages/foo/src/b.ts'],
          validation_commands: ['pnpm vitest run packages/foo/src/__tests__/b.test.ts'],
        },
      ],
    };

    expect(checkTaskValidationCommandsDeclarationMismatch(manifest)).toBeNull();
  });

  it('flags a task whose validation_command targets a file in the same task reference_files', () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'task 1',
          expected_files: ['packages/foo/src/a.ts'],
          reference_files: ['packages/foo/src/__tests__/a.test.ts'],
          validation_commands: ['pnpm vitest run packages/foo/src/__tests__/a.test.ts'],
        },
      ],
    };

    const diagnostic = checkTaskValidationCommandsDeclarationMismatch(manifest);
    expect(diagnostic).not.toBeNull();
    expect(diagnostic).toContain('Task 1');
    expect(diagnostic).toContain('reference_files');
    expect(diagnostic).toContain('packages/foo/src/__tests__/a.test.ts');
    expect(diagnostic).toContain('expected_files');
  });

  it('flags a cross-task conflict: validation_command targets a file declared as expected in an earlier task and as reference in the current task', () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 'task 1',
          expected_files: [
            'packages/application/src/review-fix/__tests__/review-fix-protected-files.test.ts',
          ],
        },
        {
          n: 2,
          title: 'task 2',
          reference_files: [
            'packages/application/src/review-fix/__tests__/review-fix-protected-files.test.ts',
          ],
          validation_commands: [
            'pnpm vitest run packages/application/src/review-fix/__tests__/review-fix-protected-files.test.ts',
          ],
        },
      ],
    };

    const diagnostic = checkTaskValidationCommandsDeclarationMismatch(manifest);
    expect(diagnostic).not.toBeNull();
    expect(diagnostic).toContain('Task 2');
    expect(diagnostic).toContain('reference_files');
    expect(diagnostic).toContain('expected_files');
    expect(diagnostic).toContain('review-fix-protected-files.test.ts');
    expect(diagnostic).toContain('Task 1');
  });

  it('does not flag a file that was created earlier when current task does not list it in reference_files', () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 'task 1',
          expected_files: ['packages/foo/src/__tests__/shared.test.ts'],
        },
        {
          n: 2,
          title: 'task 2',
          expected_files: ['packages/foo/src/b.ts'],
          validation_commands: ['pnpm vitest run packages/foo/src/__tests__/shared.test.ts'],
        },
      ],
    };

    expect(checkTaskValidationCommandsDeclarationMismatch(manifest)).toBeNull();
  });

  it('does not flag validation_commands that are general (e.g. "pnpm test") with no literal target', () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'task 1',
          reference_files: ['packages/foo/src/__tests__/shared.test.ts'],
          validation_commands: ['pnpm test'],
        },
      ],
    };

    expect(checkTaskValidationCommandsDeclarationMismatch(manifest)).toBeNull();
  });

  it('does not flag glob targets that happen to match a reference_file (cannot statically determine expansion)', () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'task 1',
          reference_files: ['packages/foo/src/__tests__/a.test.ts'],
          validation_commands: ['pnpm vitest run packages/foo/src/__tests__/*.test.ts'],
        },
      ],
    };

    expect(checkTaskValidationCommandsDeclarationMismatch(manifest)).toBeNull();
  });

  it('reports each violating (task, target) pair separately so multiple conflicts are visible in one run', () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 'task 1',
          expected_files: ['packages/foo/src/a.ts'],
          reference_files: ['packages/foo/src/__tests__/a.test.ts'],
          validation_commands: ['pnpm vitest run packages/foo/src/__tests__/a.test.ts'],
        },
        {
          n: 2,
          title: 'task 2',
          expected_files: ['packages/foo/src/b.ts'],
          reference_files: ['packages/foo/src/__tests__/b.test.ts'],
          validation_commands: ['pnpm vitest run packages/foo/src/__tests__/b.test.ts'],
        },
      ],
    };

    const diagnostic = checkTaskValidationCommandsDeclarationMismatch(manifest);
    expect(diagnostic).not.toBeNull();
    expect(diagnostic).toContain('Task 1');
    expect(diagnostic).toContain('Task 2');
    expect(diagnostic).toContain('a.test.ts');
    expect(diagnostic).toContain('b.test.ts');
  });

  it('accepts a validation_commands array form (argv-style)', () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'task 1',
          reference_files: ['packages/foo/src/__tests__/a.test.ts'],
          validation_commands: [['pnpm', 'vitest', 'run', 'packages/foo/src/__tests__/a.test.ts']],
        },
      ],
    };

    const diagnostic = checkTaskValidationCommandsDeclarationMismatch(manifest);
    expect(diagnostic).not.toBeNull();
    expect(diagnostic).toContain('Task 1');
    expect(diagnostic).toContain('packages/foo/src/__tests__/a.test.ts');
  });
});

describe('checkRedTaskValidationParity', () => {
  it('returns null for valid red tasks with negation', () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 't1',
          task_type: 'red',
          validation_commands: ['! pnpm test'],
          paired_with_task: 2,
        },
        { n: 2, title: 't2', validation_commands: ['pnpm test'] },
      ],
    };
    expect(checkRedTaskValidationParity(manifest)).toBeNull();
  });

  it('diagnoses red tasks lacking negation', () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [{ n: 1, title: 't1', task_type: 'red', validation_commands: ['pnpm test'] }],
    };
    expect(checkRedTaskValidationParity(manifest)).toContain(
      "task_type is 'red' but it lacks '! ' negation",
    );
  });

  it('diagnoses red tasks with empty validation_commands', () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [{ n: 1, title: 't1', task_type: 'red', validation_commands: [] }],
    };
    expect(checkRedTaskValidationParity(manifest)).toContain(
      "task_type is 'red' but it lacks '! ' negation",
    );
  });

  it('diagnoses red tasks sharing logically identical validation expectations with paired task', () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 't1',
          task_type: 'red',
          validation_commands: ['! pnpm test file.ts'],
          paired_with_task: 2,
        },
        { n: 2, title: 't2', validation_commands: ['! pnpm test file.ts'] },
      ],
    };
    expect(checkRedTaskValidationParity(manifest)).toContain(
      'logically identical validation commands',
    );
  });
});

describe('checkTaskValidationCommandsDoubleInversion', () => {
  it('flags it.fails() and test.fails() in test files targeted by inverted validation commands', async () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Red task',
          task_type: 'red',
          validation_commands: ['! pnpm test -- src/proof.test.ts'],
        },
      ],
    };

    const files: Record<string, string> = {
      'src/proof.test.ts': `
        import { describe, it } from 'vitest';
        describe('proof', () => {
          it.fails('reproduces bug', () => {
            expect(1).toBe(2);
          });
        });
      `,
    };

    const diagnostic = await checkTaskValidationCommandsDoubleInversion(manifest, {
      worktreeRoot: '/fake',
      readWorktreeFile: (p) => files[p] ?? null,
    });

    expect(diagnostic).not.toBeNull();
    expect(diagnostic).toContain('Task 1');
    expect(diagnostic).toContain('src/proof.test.ts');
    expect(diagnostic).toContain('uses test-runner inversion helper (`it.fails`)');
  });

  it('returns null when targeted test file contains standard direct assertions without runner-level inversion', async () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Red task',
          task_type: 'red',
          validation_commands: ['! pnpm test -- src/proof.test.ts'],
        },
      ],
    };

    const files: Record<string, string> = {
      'src/proof.test.ts': `
        import { describe, it, expect } from 'vitest';
        describe('proof', () => {
          it('reproduces bug', () => {
            expect(1).toBe(2);
          });
        });
      `,
    };

    const diagnostic = await checkTaskValidationCommandsDoubleInversion(manifest, {
      worktreeRoot: '/fake',
      readWorktreeFile: (p) => files[p] ?? null,
    });

    expect(diagnostic).toBeNull();
  });

  it('returns null when validation command is not inverted', async () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Standard task',
          validation_commands: ['pnpm test -- src/proof.test.ts'],
        },
      ],
    };

    const files: Record<string, string> = {
      'src/proof.test.ts': `
        it.fails('known permanent limitation', () => { expect(1).toBe(2); });
      `,
    };

    const diagnostic = await checkTaskValidationCommandsDoubleInversion(manifest, {
      worktreeRoot: '/fake',
      readWorktreeFile: (p) => files[p] ?? null,
    });

    expect(diagnostic).toBeNull();
  });

  it('returns null when targeted file is missing', async () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Red task',
          task_type: 'red',
          validation_commands: ['! pnpm test -- src/missing.test.ts'],
        },
      ],
    };

    const diagnostic = await checkTaskValidationCommandsDoubleInversion(manifest, {
      worktreeRoot: '/fake',
      readWorktreeFile: () => null,
    });

    expect(diagnostic).toBeNull();
  });
});

describe('inverted validation commands revalidation evaluation', () => {
  it('isNegatedValidationCommand detects leading ! prefix in string and argv forms', () => {
    expect(isNegatedValidationCommand('! pnpm test')).toBe(true);
    expect(isNegatedValidationCommand('!pnpm test')).toBe(true);
    expect(isNegatedValidationCommand(['!', 'pnpm', 'test'])).toBe(true);
    expect(isNegatedValidationCommand(['! pnpm', 'test'])).toBe(true);

    expect(isNegatedValidationCommand('pnpm test')).toBe(false);
    expect(isNegatedValidationCommand(['pnpm', 'test'])).toBe(false);
  });

  it('stripNegationPrefix removes leading ! prefix cleanly', () => {
    expect(stripNegationPrefix('! pnpm vitest run src/foo.test.ts')).toBe(
      'pnpm vitest run src/foo.test.ts',
    );
    expect(stripNegationPrefix('!pnpm vitest run src/foo.test.ts')).toBe(
      'pnpm vitest run src/foo.test.ts',
    );
    expect(
      stripNegationPrefix(['!', 'pnpm', 'vitest', 'run', 'src/foo.test.ts']),
    ).toEqual(['pnpm', 'vitest', 'run', 'src/foo.test.ts']);
    expect(
      stripNegationPrefix(['! pnpm', 'vitest', 'run', 'src/foo.test.ts']),
    ).toEqual(['pnpm', 'vitest', 'run', 'src/foo.test.ts']);
  });

  it('extractTargetTestFilesFromInvertedCommands extracts target paths from inverted commands', () => {
    const commands: ValidationCommand[] = [
      'pnpm -r test',
      '! pnpm vitest run packages/application/src/__tests__/my-proof.test.ts',
      ['!', 'pnpm', 'vitest', 'run', 'packages/infrastructure/src/__tests__/other-proof.spec.ts'],
    ];

    const targets = extractTargetTestFilesFromInvertedCommands(commands);
    expect(targets).toEqual([
      'packages/application/src/__tests__/my-proof.test.ts',
      'packages/infrastructure/src/__tests__/other-proof.spec.ts',
    ]);
  });

  it('extractFailedTestFilesFromOutput parses test runner outputs accurately', () => {
    const vitestOutput = `
 RUN  v2.1.9 /app/packages/application

 ❯ packages/application/src/__tests__/my-proof.test.ts (1)
   × proof fails as expected

 FAIL  packages/application/src/__tests__/my-proof.test.ts [ packages/application/src/__tests__/my-proof.test.ts ]
Error: expected false to be true

 Test Files  1 failed (1)
`;

    expect(extractFailedTestFilesFromOutput(vitestOutput)).toEqual([
      'packages/application/src/__tests__/my-proof.test.ts',
    ]);

    const jestOutput = `
FAIL packages/foo/src/bar.spec.tsx
  ● Bar component › renders error

Test Suites: 1 failed, 1 total
`;
    expect(extractFailedTestFilesFromOutput(jestOutput)).toEqual([
      'packages/foo/src/bar.spec.tsx',
    ]);

    const batsOutput = `
not ok 1 scripts/lib/__tests__/fix-review-task-loop.bats
`;
    expect(extractFailedTestFilesFromOutput(batsOutput)).toEqual([
      'scripts/lib/__tests__/fix-review-task-loop.bats',
    ]);
  });

  it('isPathMatchedByExpectedTarget handles exact, suffix, and relative matches', () => {
    expect(
      isPathMatchedByExpectedTarget(
        'packages/application/src/__tests__/my-proof.test.ts',
        'packages/application/src/__tests__/my-proof.test.ts',
      ),
    ).toBe(true);

    expect(
      isPathMatchedByExpectedTarget(
        'src/__tests__/my-proof.test.ts',
        'packages/application/src/__tests__/my-proof.test.ts',
      ),
    ).toBe(true);

    expect(
      isPathMatchedByExpectedTarget(
        'packages/application/src/__tests__/my-proof.test.ts',
        'src/__tests__/my-proof.test.ts',
      ),
    ).toBe(true);

    expect(
      isPathMatchedByExpectedTarget(
        'packages/application/src/__tests__/other.test.ts',
        'packages/application/src/__tests__/my-proof.test.ts',
      ),
    ).toBe(false);
  });

  it('returns [] when vitest output is truncated before summary line sentinel', () => {
    const truncatedVitestOutput = `
 RUN  v2.1.9 /app/apps/api

 ❯ apps/api/src/__tests__/cli.test.ts (1)
   × exits 1 on failed run
   stderr: Error: command failed with code 1 at apps/api/src/__tests__/cli.test.ts:42

 FAIL  apps/api/src/__tests__/cli.test.ts
`;

    expect(extractFailedTestFilesFromOutput(truncatedVitestOutput)).toEqual([]);
  });

  it('evaluateRevalidationWithInvertedCommands excuses full-suite test failure when caused solely by inverted RED tests', async () => {
    const taskValidationCommands: ValidationCommand[] = [
      '! pnpm vitest run packages/application/src/__tests__/my-proof.test.ts',
    ];

    const validationRunCommands = [
      { command: 'pnpm -r build', outcome: 'passed' },
      { command: 'pnpm -r typecheck', outcome: 'passed' },
      { command: 'pnpm lint', outcome: 'passed' },
      { command: 'pnpm boundaries', outcome: 'passed' },
      {
        command: 'pnpm -r test',
        outcome: 'failed',
        stdoutPath: '/tmp/test-stdout.log',
        stderrPath: '/tmp/test-stderr.log',
      },
      {
        command: '! pnpm vitest run packages/application/src/__tests__/my-proof.test.ts',
        outcome: 'passed',
      },
    ];

    const mockLogs: Record<string, string> = {
      '/tmp/test-stdout.log': `
 FAIL  packages/application/src/__tests__/my-proof.test.ts [ packages/application/src/__tests__/my-proof.test.ts ]
Error: expected false to be true

 Test Files  1 failed (1)
`,
      '/tmp/test-stderr.log': '',
    };

    const res = await evaluateRevalidationWithInvertedCommands({
      validationRunCommands,
      taskValidationCommands,
      readTail: async (p) => mockLogs[p] ?? '',
    });

    expect(res.passed).toBe(true);
    expect(res.failingCommands).toEqual([]);
  });

  it('evaluateRevalidationWithInvertedCommands fails when an unrelated test file also fails', async () => {
    const taskValidationCommands: ValidationCommand[] = [
      '! pnpm vitest run packages/application/src/__tests__/my-proof.test.ts',
    ];

    const validationRunCommands = [
      {
        command: 'pnpm -r test',
        outcome: 'failed',
        stdoutPath: '/tmp/test-stdout.log',
      },
    ];

    const mockLogs: Record<string, string> = {
      '/tmp/test-stdout.log': `
 FAIL  packages/application/src/__tests__/my-proof.test.ts
 FAIL  packages/application/src/review-fix/__tests__/unrelated.test.ts

 Test Files  2 failed (2)
`,
    };

    const res = await evaluateRevalidationWithInvertedCommands({
      validationRunCommands,
      taskValidationCommands,
      readTail: async (p) => mockLogs[p] ?? '',
    });

    expect(res.passed).toBe(false);
    expect(res.failingCommands).toHaveLength(1);
    expect(res.failingCommands[0]?.command).toBe('pnpm -r test');
  });

  it('evaluateRevalidationWithInvertedCommands fails when a build/syntax error causes 0 test files to be identified', async () => {
    const taskValidationCommands: ValidationCommand[] = [
      '! pnpm vitest run packages/application/src/__tests__/my-proof.test.ts',
    ];

    const validationRunCommands = [
      {
        command: 'pnpm -r test',
        outcome: 'failed',
        stdoutPath: '/tmp/test-stdout.log',
      },
    ];

    const mockLogs: Record<string, string> = {
      '/tmp/test-stdout.log': 'SyntaxError: Unexpected token export in src/index.ts',
    };

    const res = await evaluateRevalidationWithInvertedCommands({
      validationRunCommands,
      taskValidationCommands,
      readTail: async (p) => mockLogs[p] ?? '',
    });

    expect(res.passed).toBe(false);
    expect(res.failingCommands).toHaveLength(1);
  });

  it('evaluateRevalidationWithInvertedCommands fails when an inverted command itself fails', async () => {
    const taskValidationCommands: ValidationCommand[] = [
      '! pnpm vitest run packages/application/src/__tests__/my-proof.test.ts',
    ];

    const validationRunCommands = [
      {
        command: '! pnpm vitest run packages/application/src/__tests__/my-proof.test.ts',
        outcome: 'failed',
      },
    ];

    const res = await evaluateRevalidationWithInvertedCommands({
      validationRunCommands,
      taskValidationCommands,
      readTail: async () => '',
    });

    expect(res.passed).toBe(false);
    expect(res.failingCommands).toHaveLength(1);
    expect(res.failingCommands[0]?.command).toBe(
      '! pnpm vitest run packages/application/src/__tests__/my-proof.test.ts',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { buildTaskValidationCommands } from '../task-validation-commands.js';
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
  it('literal single-file vitest commands are made strict', () => {
    const commands = [
      'vitest run "src/foo.test.ts"',
      "vitest run 'src/foo.spec.tsx' --reporter=verbose",
      'pnpm vitest run src/foo.test.mts',
      'pnpm exec vitest run src/foo.spec.cts',
      'npx vitest run src/foo.test.js',
    ];

    expect(buildTaskValidationCommands(manifestWithCommands(commands), 1)).toEqual(
      commands.map((command) => `${command} --passWithNoTests=false`),
    );
  });

  it('broad and unsupported validation commands are preserved', () => {
    const commands = [
      'vitest run',
      'vitest run "src/**/*.test.ts"',
      'vitest run src',
      'vitest run --project unit',
      'vitest run src/a.test.ts src/b.test.ts',
      'DATABASE_URL=x vitest run src/foo.test.ts',
      'vitest run src/foo.test.ts && echo done',
      'eslint src/foo.test.ts',
    ];

    expect(buildTaskValidationCommands(manifestWithCommands(commands), 1)).toEqual(commands);
  });

  it('an existing passWithNoTests flag is normalized without duplication', () => {
    const commands = [
      'vitest run src/a.test.ts --passWithNoTests=false',
      'vitest run src/b.test.ts --passWithNoTests',
      'vitest run src/c.test.ts --passWithNoTests=true',
    ];

    const result = buildTaskValidationCommands(manifestWithCommands(commands), 1);
    expect(result).toEqual([
      'vitest run src/a.test.ts --passWithNoTests=false',
      'vitest run src/b.test.ts --passWithNoTests=false',
      'vitest run src/c.test.ts --passWithNoTests=false',
    ]);
    expect(result.every((command) => command.match(/--passWithNoTests/g)?.length === 1)).toBe(true);
  });

  it('selects commands by manifest version and returns none for an absent task', () => {
    const v1Manifest: TaskManifest = {
      version: 1,
      tasks: [
        {
          n: 1,
          title: 'V1 Task',
          description: 'Desc',
          files: [],
          validation: ['vitest run src/v1.test.ts'],
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
          validation_commands: ['vitest run src/v2.test.ts'],
        },
      ],
    };

    expect(buildTaskValidationCommands(v1Manifest, 1)).toEqual([
      'vitest run src/v1.test.ts --passWithNoTests=false',
    ]);
    expect(buildTaskValidationCommands(v2Manifest, 1)).toEqual([
      'vitest run src/v2.test.ts --passWithNoTests=false',
    ]);
    expect(buildTaskValidationCommands(v2Manifest, 999)).toEqual([]);
  });

  it('declared drizzle SQL migrations receive leading existence guards', () => {
    const manifest = manifestWith({
      expectedFiles: [
        'drizzle/0001_root.sql',
        'packages/adapters/drizzle/0002_execution_origin.sql',
      ],
      commands: ['pnpm test'],
    });

    const result = buildTaskValidationCommands(manifest, 1);
    expect(result).toEqual([
      "test -f 'drizzle/0001_root.sql' || { printf '%s\\n' 'Required migration file was never created: drizzle/0001_root.sql' >&2; exit 1; }",
      "test -f 'packages/adapters/drizzle/0002_execution_origin.sql' || { printf '%s\\n' 'Required migration file was never created: packages/adapters/drizzle/0002_execution_origin.sql' >&2; exit 1; }",
      'pnpm test',
    ]);
  });

  it('non-migration expected files do not receive existence guards', () => {
    const manifest = manifestWith({
      expectedFiles: [
        'packages/adapters/src/schema.ts',
        'packages/adapters/sql/0001_not_drizzle.sql',
        'packages/adapters/drizzle/meta.json',
      ],
      commands: ['pnpm test'],
    });

    expect(buildTaskValidationCommands(manifest, 1)).toEqual(['pnpm test']);
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
          validation: ['pnpm test'],
        },
      ],
    };

    const result = buildTaskValidationCommands(v1Manifest, 1);
    expect(result).toEqual([
      "test -f 'drizzle/0001_v1.sql' || { printf '%s\\n' 'Required migration file was never created: drizzle/0001_v1.sql' >&2; exit 1; }",
      'pnpm test',
    ]);
  });

  it('adds strict no-tests handling to literal argv vitest commands', () => {
    const commands: ValidationCommand[] = [
      ['vitest', 'run', 'src/foo.test.ts'],
      ['pnpm', 'vitest', 'run', 'src/foo.spec.tsx', '--reporter=verbose'],
      ['pnpm', 'exec', 'vitest', 'run', 'src/foo.test.mts', '--passWithNoTests'],
      ['npx', 'vitest', 'run', 'src/foo.test.js', '--passWithNoTests=true'],
    ];

    expect(buildTaskValidationCommands(manifestWithCommands(commands), 1)).toEqual([
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
    ]);
  });

  it('preserves broad and unsupported argv validation commands', () => {
    const commands: ValidationCommand[] = [
      ['vitest', 'run'],
      ['vitest', 'run', 'src/*.test.ts'],
      ['vitest', 'run', 'src'],
      ['vitest', 'run', '--project', 'unit'],
      ['vitest', 'run', 'src/a.test.ts', 'src/b.test.ts'],
      ['pnpm', 'exec', 'eslint', 'apps/app/app/position/[id].tsx'],
    ];

    expect(buildTaskValidationCommands(manifestWithCommands(commands), 1)).toEqual(commands);
  });

  it('preserves mixed validation command order and representation', () => {
    const manifest = manifestWith({
      expectedFiles: ['drizzle/0001_root.sql'],
      commands: [
        'pnpm lint',
        ['pnpm', 'exec', 'eslint', 'apps/app/app/position/[id].tsx'],
        ['vitest', 'run', 'src/foo.test.ts'],
      ],
    });

    const result = buildTaskValidationCommands(manifest, 1);
    expect(result).toEqual([
      "test -f 'drizzle/0001_root.sql' || { printf '%s\\n' 'Required migration file was never created: drizzle/0001_root.sql' >&2; exit 1; }",
      'pnpm lint',
      ['pnpm', 'exec', 'eslint', 'apps/app/app/position/[id].tsx'],
      ['vitest', 'run', 'src/foo.test.ts', '--passWithNoTests=false'],
    ]);
  });
});

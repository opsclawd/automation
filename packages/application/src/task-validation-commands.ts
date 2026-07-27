import type { TaskManifest } from './phases/plan-tasks.js';
import type { ValidationCommand } from './ports/validation-port.js';

const DIRECT_VITEST_RUN =
  /^(?:(?:pnpm|npx)(?:\s+exec)?\s+)?vitest\s+run\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))((?:\s+.*)?)$/;
const LITERAL_TEST_FILE = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const GLOB_METACHARACTERS = /[*?[{]/;
const PASS_WITH_NO_TESTS = /--passWithNoTests(?:=(?:true|false))?/;
const DRIZZLE_MIGRATION = /(?:^|\/)drizzle\/.+\.sql$/;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function migrationExistenceGuard(path: string): string {
  const message = `Required migration file was never created: ${path}`;
  return `test -f ${shellQuote(path)} || { printf '%s\\n' ${shellQuote(message)} >&2; exit 1; }`;
}

function makeLiteralVitestStringStrict(command: string): string {
  const match = DIRECT_VITEST_RUN.exec(command);
  if (!match) return command;

  const target = match[1] ?? match[2] ?? match[3] ?? '';
  const trailing = match[4] ?? '';
  if (
    !LITERAL_TEST_FILE.test(target) ||
    GLOB_METACHARACTERS.test(target) ||
    /(?:&&|\|\||[;|<>])/.test(trailing) ||
    trailing.split(/\s+/).filter((arg) => arg.length > 0 && !arg.startsWith('-')).length > 0
  ) {
    return command;
  }

  if (PASS_WITH_NO_TESTS.test(command)) {
    return command.replace(PASS_WITH_NO_TESTS, '--passWithNoTests=false');
  }
  return `${command} --passWithNoTests=false`;
}

function parseVitestArgv(command: string[]): { target: string; trailing: string[] } | null {
  if (command.length < 3) return null;
  if (command[0] === 'vitest' && command[1] === 'run') {
    return { target: command[2]!, trailing: command.slice(3) };
  }
  if (
    command.length >= 4 &&
    command[0] === 'pnpm' &&
    command[1] === 'vitest' &&
    command[2] === 'run'
  ) {
    return { target: command[3]!, trailing: command.slice(4) };
  }
  if (
    command.length >= 5 &&
    command[0] === 'pnpm' &&
    command[1] === 'exec' &&
    command[2] === 'vitest' &&
    command[3] === 'run'
  ) {
    return { target: command[4]!, trailing: command.slice(5) };
  }
  if (
    command.length >= 4 &&
    command[0] === 'npx' &&
    command[1] === 'vitest' &&
    command[2] === 'run'
  ) {
    return { target: command[3]!, trailing: command.slice(4) };
  }
  return null;
}

function makeLiteralVitestArgvStrict(command: string[]): string[] {
  const parsed = parseVitestArgv(command);
  if (!parsed) return command;

  const { target, trailing } = parsed;
  if (
    !LITERAL_TEST_FILE.test(target) ||
    GLOB_METACHARACTERS.test(target) ||
    trailing.some((arg) => !arg.startsWith('-'))
  ) {
    return command;
  }

  const passWithNoTestsIdx = command.findIndex((arg) =>
    /^--passWithNoTests(?:=(?:true|false))?$/.test(arg),
  );

  if (passWithNoTestsIdx !== -1) {
    return command
      .map((arg, idx) => (idx === passWithNoTestsIdx ? '--passWithNoTests=false' : arg))
      .filter(
        (arg, idx) =>
          idx === passWithNoTestsIdx || !/^--passWithNoTests(?:=(?:true|false))?$/.test(arg),
      );
  }

  return [...command, '--passWithNoTests=false'];
}

function makeLiteralVitestCommandStrict(command: ValidationCommand): ValidationCommand {
  return Array.isArray(command)
    ? makeLiteralVitestArgvStrict(command)
    : makeLiteralVitestStringStrict(command);
}

export function buildTaskValidationCommands(
  manifest: TaskManifest,
  taskNumber: number,
): ValidationCommand[] {
  const task = manifest.tasks.find((candidate) => candidate.n === taskNumber);
  if (!task) return [];

  let commands: ValidationCommand[];
  if (manifest.version === 2) {
    commands = (task as { validation_commands?: ValidationCommand[] }).validation_commands ?? [];
  } else {
    commands = (task as { validation?: string[] }).validation ?? [];
  }

  const migrationPaths: string[] = [];
  if (manifest.version === 2) {
    const unique = new Set([
      ...[...((task as { expected_files?: string[] }).expected_files ?? [])],
      ...[...((task as { files?: string[] }).files ?? [])],
    ]);
    migrationPaths.push(...[...unique].filter((path) => DRIZZLE_MIGRATION.test(path)));
  } else {
    const unique = new Set([...((task as { files?: string[] }).files ?? [])]);
    migrationPaths.push(...[...unique].filter((path) => DRIZZLE_MIGRATION.test(path)));
  }

  return [
    ...migrationPaths.map(migrationExistenceGuard),
    ...commands.map(makeLiteralVitestCommandStrict),
  ];
}

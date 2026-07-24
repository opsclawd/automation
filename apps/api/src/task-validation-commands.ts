import type { TaskManifest } from '@ai-sdlc/application';

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

function makeLiteralVitestCommandStrict(command: string): string {
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

export function buildTaskValidationCommands(manifest: TaskManifest, taskNumber: number): string[] {
  const task = manifest.tasks.find((candidate) => candidate.n === taskNumber);
  if (!task) return [];

  let commands: string[];
  if (manifest.version === 2) {
    commands = (task as { validation_commands?: string[] }).validation_commands ?? [];
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

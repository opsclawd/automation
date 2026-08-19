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

export interface CheckTaskValidationCommandsOptions {
  worktreeRoot?: string;
  readWorktreeFile?: (path: string) => Promise<string | null> | string | null;
}

export function globToRegex(glob: string): RegExp {
  const norm = glob.replace(/\\/g, '/').trim();
  let regexStr = '';
  let i = 0;
  while (i < norm.length) {
    if (norm.slice(i, i + 3) === '**/') {
      regexStr += '(?:.*/)?';
      i += 3;
    } else if (norm.slice(i, i + 2) === '**') {
      regexStr += '.*';
      i += 2;
    } else if (norm[i] === '*') {
      regexStr += '[^/]*';
      i++;
    } else if (norm[i] === '?') {
      regexStr += '[^/]';
      i++;
    } else if (norm[i] === '{') {
      const endIdx = norm.indexOf('}', i);
      if (endIdx !== -1) {
        const options = norm.slice(i + 1, endIdx).split(',').map((opt) => opt.trim());
        const optionRegexes = options.map((opt) => globToRegex(opt).source.slice(1, -1));
        regexStr += `(?:${optionRegexes.join('|')})`;
        i = endIdx + 1;
      } else {
        regexStr += '\\{';
        i++;
      }
    } else if (norm[i] === '[') {
      const endIdx = norm.indexOf(']', i);
      if (endIdx !== -1) {
        regexStr += norm.slice(i, endIdx + 1);
        i = endIdx + 1;
      } else {
        regexStr += '\\[';
        i++;
      }
    } else if ('./+^$()|\\'.includes(norm[i]!)) {
      regexStr += '\\' + norm[i];
      i++;
    } else {
      regexStr += norm[i];
      i++;
    }
  }
  return new RegExp(`^${regexStr}$`, 'i');
}

export function parseRunnerConfigExclusions(configContent: string): {
  include: string[];
  exclude: string[];
} {
  const extractArrayStrings = (block: string): string[] => {
    const results: string[] = [];
    const strRegex = /["']([^"']+)["']/g;
    let match;
    while ((match = strRegex.exec(block)) !== null) {
      if (match[1]) results.push(match[1]);
    }
    return results;
  };

  const excludePatterns: string[] = [];
  const includePatterns: string[] = [];

  const excludeRegex = /(?:exclude|testPathIgnorePatterns)\s*:\s*\[([\s\S]*?)\]/g;
  let match;
  while ((match = excludeRegex.exec(configContent)) !== null) {
    if (match[1]) {
      excludePatterns.push(...extractArrayStrings(match[1]));
    }
  }

  const includeRegex = /(?:include|testMatch)\s*:\s*\[([\s\S]*?)\]/g;
  while ((match = includeRegex.exec(configContent)) !== null) {
    if (match[1]) {
      includePatterns.push(...extractArrayStrings(match[1]));
    }
  }

  return { include: includePatterns, exclude: excludePatterns };
}

function parseCommandArgv(command: ValidationCommand): string[] {
  if (Array.isArray(command)) {
    return command.map((arg) => String(arg).trim()).filter((arg) => arg.length > 0);
  }
  const str = String(command).trim();
  const tokens: string[] = [];
  const regex = /(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  let match;
  while ((match = regex.exec(str)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? '';
    if (token.length > 0) {
      tokens.push(token);
    }
  }
  return tokens;
}

function extractTargetTestFilePath(argv: string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith('-')) continue;
    if (
      LITERAL_TEST_FILE.test(arg) ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(arg) ||
      /\.integration\.test\.[cm]?[jt]sx?$/i.test(arg)
    ) {
      return arg.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
    }
  }
  return null;
}

export type TestRunnerKind = 'vitest' | 'jest' | 'playwright' | 'pytest';

function detectTestRunnerKind(argv: string[]): TestRunnerKind | null {
  const cmdStr = argv.join(' ').toLowerCase();
  if (cmdStr.includes('vitest')) return 'vitest';
  if (cmdStr.includes('jest')) return 'jest';
  if (cmdStr.includes('playwright')) return 'playwright';
  if (cmdStr.includes('pytest')) return 'pytest';
  return null;
}

function getRunnerConfigFiles(runner: TestRunnerKind): string[] {
  switch (runner) {
    case 'vitest':
      return [
        'vitest.config.ts',
        'vitest.config.js',
        'vitest.config.mts',
        'vitest.config.mjs',
        'vite.config.ts',
        'vite.config.js',
      ];
    case 'jest':
      return [
        'jest.config.js',
        'jest.config.ts',
        'jest.config.json',
        'jest.config.cjs',
        'jest.config.mjs',
      ];
    case 'playwright':
      return ['playwright.config.ts', 'playwright.config.js'];
    case 'pytest':
      return ['pytest.ini', 'pyproject.toml', 'setup.cfg'];
    default:
      return [];
  }
}

function hasCustomConfigFlag(argv: string[]): boolean {
  return argv.some(
    (arg, i) =>
      arg === '-c' ||
      arg === '--config' ||
      arg.startsWith('--config=') ||
      (i > 0 && (argv[i - 1] === '-c' || argv[i - 1] === '--config')),
  );
}

export async function checkTaskValidationCommandsSatisfiability(
  manifest: TaskManifest,
  options: CheckTaskValidationCommandsOptions,
): Promise<string | null> {
  const { worktreeRoot: _worktreeRoot, readWorktreeFile } = options;
  const diagnostics: string[] = [];

  const configFiles = [
    'vitest.config.ts',
    'vitest.config.js',
    'vitest.config.mts',
    'vitest.config.mjs',
    'vite.config.ts',
    'vite.config.js',
    'jest.config.js',
    'jest.config.ts',
    'jest.config.json',
    'jest.config.cjs',
    'jest.config.mjs',
    'playwright.config.ts',
    'playwright.config.js',
    'pytest.ini',
    'pyproject.toml',
    'setup.cfg',
  ];

  const configContents = new Map<string, string>();
  if (readWorktreeFile) {
    for (const configFile of configFiles) {
      try {
        const content = await readWorktreeFile(configFile);
        if (content) configContents.set(configFile, content);
      } catch {
        // ignore
      }
    }
  }

  for (const task of manifest.tasks) {
    const rawCommands = buildTaskValidationCommands(manifest, task.n);
    for (const rawCmd of rawCommands) {
      const argv = parseCommandArgv(rawCmd);
      if (argv.length === 0) continue;

      const runnerKind = detectTestRunnerKind(argv);
      if (!runnerKind) continue;

      const targetPath = extractTargetTestFilePath(argv);
      if (!targetPath) continue;

      const cmdDisplay = Array.isArray(rawCmd) ? JSON.stringify(rawCmd) : `"${rawCmd}"`;
      const relevantConfigFiles = getRunnerConfigFiles(runnerKind);

      // Static config check
      if (!hasCustomConfigFlag(argv) && configContents.size > 0) {
        for (const configFile of relevantConfigFiles) {
          const content = configContents.get(configFile);
          if (!content) continue;

          const { include, exclude } = parseRunnerConfigExclusions(content);

          let isExcluded = false;
          let matchedExcludePattern: string | undefined;

          if (exclude.length > 0) {
            for (const excl of exclude) {
              const regex = globToRegex(excl);
              if (regex.test(targetPath)) {
                isExcluded = true;
                matchedExcludePattern = excl;
                break;
              }
            }
          }

          if (isExcluded && matchedExcludePattern) {
            diagnostics.push(
              `Task ${task.n}: validation_command ${cmdDisplay} is unsatisfiable by construction: the test runner cannot select the named target "${targetPath}" (target path "${targetPath}" is excluded by the runner's configuration (${configFile} excludes "${matchedExcludePattern}")).`,
            );
            break;
          }

          if (include.length > 0) {
            const matchesInclude = include.some((inc) => globToRegex(inc).test(targetPath));
            if (!matchesInclude) {
              diagnostics.push(
                `Task ${task.n}: validation_command ${cmdDisplay} is unsatisfiable by construction: the test runner cannot select the named target "${targetPath}" (target path "${targetPath}" does not match included test patterns in ${configFile}).`,
              );
              break;
            }
          }
        }
      }
    }
  }

  if (diagnostics.length === 0) return null;
  return diagnostics.join('\n\n');
}

export interface ExpandTaskValidationCommandsOptions {
  changedFiles: string[];
  existingCommands: ValidationCommand[];
  worktreeRoot?: string;
  fileExists?: (relativePath: string) => boolean;
}

export function isTestFileCoveredByCommands(
  testPath: string,
  existingCommands: ValidationCommand[],
): boolean {
  const normTestPath = testPath.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');

  for (const cmd of existingCommands) {
    if (typeof cmd === 'string' && cmd.trimStart().startsWith('!')) {
      continue;
    }

    const argv = parseCommandArgv(cmd);
    if (argv.length === 0) continue;

    const cmdStr = Array.isArray(cmd) ? cmd.join(' ') : String(cmd);
    if (
      cmdStr.includes(normTestPath) ||
      cmdStr.includes(`./${normTestPath}`) ||
      argv.includes(normTestPath) ||
      argv.includes(`./${normTestPath}`)
    ) {
      return true;
    }

    const targetPath = extractTargetTestFilePath(argv);
    if (targetPath) {
      if (targetPath === normTestPath) {
        return true;
      }
      // Command specifically targets a different literal test file, so it does not cover normTestPath
      continue;
    }

    // Check positional non-flag arguments for globs or directory prefixes
    const positionalArgs = argv.slice(1).filter((arg) => {
      if (arg.startsWith('-')) return false;
      if (['run', 'exec', 'test', 'vitest', 'jest', 'playwright', 'pytest', 'pnpm', 'npx', 'npm'].includes(arg.toLowerCase())) {
        return false;
      }
      return true;
    });

    if (positionalArgs.length === 0) {
      // General test runner command with no file/dir restrictions (e.g. pnpm test, vitest run)
      return true;
    }

    for (const arg of positionalArgs) {
      const cleanArg = arg.replace(/^["']|["']$/g, '').replace(/\\/g, '/');
      if (GLOB_METACHARACTERS.test(cleanArg)) {
        if (globToRegex(cleanArg).test(normTestPath)) {
          return true;
        }
      } else {
        const normDir = cleanArg.replace(/\/+$/, '');
        if (normTestPath === normDir || normTestPath.startsWith(`${normDir}/`)) {
          return true;
        }
      }
    }
  }

  return false;
}

export function buildTargetedTestCommand(
  testPath: string,
  existingCommands: ValidationCommand[],
): ValidationCommand {
  const normTestPath = testPath.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
  let detectedRunner: TestRunnerKind | null = null;

  for (const cmd of existingCommands) {
    const argv = parseCommandArgv(cmd);
    const runner = detectTestRunnerKind(argv);
    if (runner) {
      detectedRunner = runner;
      break;
    }
  }

  switch (detectedRunner) {
    case 'jest':
      return `pnpm jest ${shellQuote(normTestPath)}`;
    case 'playwright':
      return `pnpm playwright test ${shellQuote(normTestPath)}`;
    case 'pytest':
      return `pytest ${shellQuote(normTestPath)}`;
    case 'vitest':
    default:
      return makeLiteralVitestStringStrict(`pnpm vitest run ${shellQuote(normTestPath)}`);
  }
}

export function expandTaskValidationCommandsWithNewTests(
  options: ExpandTaskValidationCommandsOptions,
): ValidationCommand[] {
  const { changedFiles, existingCommands, worktreeRoot: _worktreeRoot, fileExists } = options;
  if (!changedFiles || changedFiles.length === 0) {
    return existingCommands;
  }

  const checkExists = (relPath: string): boolean => {
    if (fileExists) return fileExists(relPath);
    return false;
  };

  const discoveredTestFiles = new Set<string>();

  for (const rawPath of changedFiles) {
    const normPath = rawPath.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
    if (!normPath) continue;

    if (LITERAL_TEST_FILE.test(normPath) || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(normPath)) {
      if (checkExists(normPath)) {
        discoveredTestFiles.add(normPath);
      }
      continue;
    }

    // Source file: check for co-located tests
    const lastSlash = normPath.lastIndexOf('/');
    const dir = lastSlash !== -1 ? normPath.slice(0, lastSlash) : '.';
    const filename = lastSlash !== -1 ? normPath.slice(lastSlash + 1) : normPath;
    const nameWithoutExt = filename.replace(/\.[cm]?[jt]sx?$/i, '');

    if (!nameWithoutExt || nameWithoutExt === filename) continue;

    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs'];
    const candidates: string[] = [];

    for (const ext of extensions) {
      candidates.push(`${dir}/__tests__/${nameWithoutExt}.test${ext}`);
      candidates.push(`${dir}/__tests__/${nameWithoutExt}.spec${ext}`);
      candidates.push(`${dir}/${nameWithoutExt}.test${ext}`);
      candidates.push(`${dir}/${nameWithoutExt}.spec${ext}`);
    }

    for (const candidate of candidates) {
      const cleanCandidate = candidate.replace(/^\.\//, '');
      if (checkExists(cleanCandidate)) {
        discoveredTestFiles.add(cleanCandidate);
      }
    }
  }

  const uncoveredTestFiles: string[] = [];
  for (const testPath of discoveredTestFiles) {
    if (!isTestFileCoveredByCommands(testPath, existingCommands)) {
      uncoveredTestFiles.push(testPath);
    }
  }

  if (uncoveredTestFiles.length === 0) {
    return existingCommands;
  }

  const newCommands = uncoveredTestFiles.map((testPath) =>
    buildTargetedTestCommand(testPath, existingCommands),
  );

  return [...existingCommands, ...newCommands];
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

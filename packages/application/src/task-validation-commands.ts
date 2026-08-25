import type { TaskManifest } from './phases/plan-tasks.js';
import type { ValidationCommand } from './ports/validation-port.js';
import { normalizeTaskPath } from './task-file-boundaries.js';

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

export function isRedundantValidationCommand(command: ValidationCommand): boolean {
  const argv = parseCommandArgv(command);
  if (argv.length === 0) return false;

  // Never drop inverted commands (RED-first tests: `! ...`)
  if (argv[0]?.startsWith('!')) return false;

  // Never drop git checks or guard scripts
  const first = argv[0]!;
  if (first === 'git' || first === 'test' || first.startsWith('.')) {
    return false;
  }

  // Strip leading pnpm / npx / exec / --filter <pkg>
  let idx = 0;
  if (argv[idx] === 'pnpm' || argv[idx] === 'npx') {
    idx++;
  }
  while (idx < argv.length) {
    if (argv[idx] === '--filter') {
      idx += 2;
    } else if (argv[idx] === 'exec' || argv[idx] === 'run') {
      idx++;
    } else if (argv[idx]?.startsWith('-')) {
      idx++;
    } else {
      break;
    }
  }

  if (idx >= argv.length) return false;
  const sub = argv[idx]!;
  const rest = argv.slice(idx + 1);

  // `typecheck` / `tsc` without positional files is redundant with global typecheck
  if (sub === 'typecheck' || sub === 'tsc') {
    const positional = rest.filter((a) => !a.startsWith('-'));
    return positional.length === 0;
  }

  // `test` without positional file targets is redundant with global `pnpm test`
  if (sub === 'test') {
    const positional = rest.filter((a) => !a.startsWith('-'));
    return positional.length === 0;
  }

  // `lint` without positional file targets is redundant with global `pnpm lint`
  if (sub === 'lint') {
    const positional = rest.filter((a) => !a.startsWith('-') && a !== '.');
    return positional.length === 0;
  }

  // `eslint` with only `.` or no files is redundant with global `pnpm lint`
  if (sub === 'eslint') {
    const positional = rest.filter((a) => !a.startsWith('-') && a !== '.');
    return positional.length === 0;
  }

  // `vitest` without positional test files is redundant with global `pnpm test`
  if (sub === 'vitest') {
    const nonFlags = rest.filter((a) => !a.startsWith('-') && a !== 'run');
    return nonFlags.length === 0;
  }

  return false;
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
        const options = norm
          .slice(i + 1, endIdx)
          .split(',')
          .map((opt) => opt.trim());
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

export function checkTaskValidationCommandsDeclarationMismatch(
  manifest: TaskManifest,
): string | null {
  if (manifest.version !== 2) return null;

  const diagnostics: string[] = [];

  const earlierExpectedFilesByPath = new Map<string, number[]>();
  for (const task of manifest.tasks) {
    const taskRecord = task as {
      expected_files?: string[] | null;
      files?: string[] | null;
    };
    const declared = [...(taskRecord.expected_files ?? []), ...(taskRecord.files ?? [])];
    for (const f of declared) {
      const norm = normalizeTaskPath(f);
      if (!norm) continue;
      const existing = earlierExpectedFilesByPath.get(norm) ?? [];
      existing.push(task.n);
      earlierExpectedFilesByPath.set(norm, existing);
    }
  }

  for (const task of manifest.tasks) {
    const taskRecord = task as {
      validation_commands?: ValidationCommand[] | null;
      reference_files?: string[] | null;
    };
    const validationCommands = taskRecord.validation_commands ?? [];
    const referenceFiles = (taskRecord.reference_files ?? [])
      .map(normalizeTaskPath)
      .filter((p): p is string => Boolean(p));
    if (referenceFiles.length === 0) continue;
    const referenceSet = new Set(referenceFiles);

    for (const cmd of validationCommands) {
      const argv = parseCommandArgv(cmd);
      if (argv.length === 0) continue;

      const target = extractTargetTestFilePath(argv);
      if (!target) continue;
      const normTarget = normalizeTaskPath(target);
      if (!normTarget) continue;

      if (GLOB_METACHARACTERS.test(normTarget)) continue;
      if (!referenceSet.has(normTarget)) continue;

      const cmdDisplay = Array.isArray(cmd) ? JSON.stringify(cmd) : `"${cmd}"`;
      const earlier = (earlierExpectedFilesByPath.get(normTarget) ?? []).filter((n) => n < task.n);

      if (earlier.length > 0) {
        const earlierTaskList =
          earlier.length === 1 ? `Task ${earlier[0]!}` : `Tasks ${earlier.join(', ')}`;
        diagnostics.push(
          `Task ${task.n}: validation_command ${cmdDisplay} targets "${normTarget}", which was created in ${earlierTaskList} as an expected output and is listed here under reference_files. Files in reference_files must not be modified by the implementation; move "${normTarget}" from reference_files to expected_files (or files) so Task ${task.n} may maintain it.`,
        );
      } else {
        diagnostics.push(
          `Task ${task.n}: validation_command ${cmdDisplay} targets "${normTarget}", but that path is declared in this task's reference_files. Files in reference_files must not be modified by the implementation; move "${normTarget}" to expected_files (or files) so the implementation may update it as part of Task ${task.n}.`,
        );
      }
    }
  }

  if (diagnostics.length === 0) return null;
  return diagnostics.join('\n\n');
}

export interface CheckTaskValidationCommandsDoubleInversionOptions {
  worktreeRoot: string;
  readWorktreeFile?: (relativePath: string) => Promise<string | null> | string | null;
}

export async function checkTaskValidationCommandsDoubleInversion(
  manifest: TaskManifest,
  options: CheckTaskValidationCommandsDoubleInversionOptions,
): Promise<string | null> {
  if (manifest.version !== 2) return null;
  const { readWorktreeFile } = options;
  if (!readWorktreeFile) return null;

  const diagnostics: string[] = [];

  for (const task of manifest.tasks) {
    const commands = task.validation_commands ?? [];
    const invertedCommands = commands.filter(isNegatedValidationCommand);
    if (invertedCommands.length === 0) continue;

    const targetFiles = extractTargetTestFilesFromInvertedCommands(invertedCommands);
    if (targetFiles.length === 0) continue;

    for (const relativePath of targetFiles) {
      let content: string | null = null;
      try {
        content = await readWorktreeFile(relativePath);
      } catch {
        content = null;
      }
      if (!content) continue;

      const pattern = /\b(?:it|test)(?:\.[a-zA-Z0-9_$]+)*\.(?:fails|failing)\b/g;
      const matches = Array.from(content.matchAll(pattern)).map((m) => m[0]);
      if (matches.length > 0) {
        const uniqueMatches = Array.from(new Set(matches)).sort();
        diagnostics.push(
          `Task ${task.n}: test file "${relativePath}" targeted by inverted validation command uses test-runner inversion helper (${uniqueMatches.map((m) => `\`${m}\``).join(', ')}). Do not use runner-level inversion helpers (such as Vitest's \`it.fails()\` or \`test.fails()\`) when the task's validation command already applies \`!\` command-level inversion, as double inversion produces the opposite of the intended validation signal. Write standard assertions so the test body throws and exits non-zero.`,
        );
      }
    }
  }

  if (diagnostics.length === 0) return null;
  return diagnostics.join('\n\n');
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
    let rawCommands: ValidationCommand[];
    if (manifest.version === 2) {
      rawCommands =
        (task as { validation_commands?: ValidationCommand[] }).validation_commands ?? [];
    } else {
      rawCommands = (task as { validation?: string[] }).validation ?? [];
    }
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
      if (
        [
          'run',
          'exec',
          'test',
          'vitest',
          'jest',
          'playwright',
          'pytest',
          'pnpm',
          'npx',
          'npm',
        ].includes(arg.toLowerCase())
      ) {
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
  const filteredExisting = existingCommands.filter((cmd) => !isRedundantValidationCommand(cmd));
  if (!changedFiles || changedFiles.length === 0) {
    return filteredExisting;
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
    if (!isTestFileCoveredByCommands(testPath, filteredExisting)) {
      uncoveredTestFiles.push(testPath);
    }
  }

  if (uncoveredTestFiles.length === 0) {
    return filteredExisting;
  }

  const newCommands = uncoveredTestFiles.map((testPath) =>
    buildTargetedTestCommand(testPath, filteredExisting),
  );

  return [...filteredExisting, ...newCommands].filter((cmd) => !isRedundantValidationCommand(cmd));
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

  const allCommands = [
    ...migrationPaths.map(migrationExistenceGuard),
    ...commands.map(makeLiteralVitestCommandStrict),
  ];

  return allCommands.filter((cmd) => !isRedundantValidationCommand(cmd));
}

export function isNegatedValidationCommand(command: ValidationCommand): boolean {
  if (Array.isArray(command)) {
    return command[0]?.trim().startsWith('!') ?? false;
  }
  return String(command).trim().startsWith('!');
}

export function stripNegationPrefix(command: ValidationCommand): ValidationCommand {
  if (Array.isArray(command)) {
    if (command.length === 0) return command;
    const first = command[0]!.trim();
    if (first.startsWith('!')) {
      const restFirst = first.slice(1).trim();
      return restFirst ? [restFirst, ...command.slice(1)] : command.slice(1);
    }
    return command;
  }
  const str = String(command).trim();
  if (str.startsWith('!')) {
    return str.slice(1).trim();
  }
  return command;
}

export function extractTargetTestFilesFromInvertedCommands(
  commands: ValidationCommand[],
): string[] {
  const targetFiles = new Set<string>();

  for (const cmd of commands) {
    if (!isNegatedValidationCommand(cmd)) continue;
    const stripped = stripNegationPrefix(cmd);
    const argv = parseCommandArgv(stripped);
    if (argv.length === 0) continue;

    const target = extractTargetTestFilePath(argv);
    if (target) {
      const norm = normalizeTaskPath(target);
      if (norm) targetFiles.add(norm);
    } else {
      for (const arg of argv.slice(1)) {
        if (arg.startsWith('-')) continue;
        const cleanArg = arg.replace(/^["']|["']$/g, '');
        if (
          LITERAL_TEST_FILE.test(cleanArg) ||
          /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(cleanArg) ||
          /\.bats$/i.test(cleanArg) ||
          /\.py$/i.test(cleanArg)
        ) {
          const norm = normalizeTaskPath(cleanArg);
          if (norm) targetFiles.add(norm);
        }
      }
    }
  }

  return Array.from(targetFiles);
}

export function extractFailedTestFilesFromOutput(output: string): string[] {
  if (!output || !output.trim()) return [];

  const found = new Set<string>();
  const lines = output.split('\n');

  const failPatterns = [
    /(?:FAIL|FAILED)\s+([^\s:]+\.(?:test|spec)\.[cm]?[jt]sx?|[^\s:]+\.bats|[^\s:]+test_[\w.-]+\.py|[^\s:]+[\w.-]+_test\.py)/gi,
    /(?:×|❯)\s+([^\s:]+\.(?:test|spec)\.[cm]?[jt]sx?|[^\s:]+\.bats)/gi,
    /\d+\)\s+(?:\[[^\]]+\]\s+›\s+)?([^\s:]+\.(?:test|spec)\.[cm]?[jt]sx?)/gi,
    /FAILED\s+([^\s:]+\.py)/gi,
    /not ok\s+\d+\s+([^\s:]+\.bats)/gi,
  ];

  for (const pattern of failPatterns) {
    let match;
    while ((match = pattern.exec(output)) !== null) {
      const file = match[1];
      if (file) {
        const norm = normalizeTaskPath(file);
        if (norm) found.add(norm);
      }
    }
  }

  const fileCandidateRegex =
    /([^\s:]+\.(?:test|spec)\.[cm]?[jt]sx?|[^\s:]+\.bats|[^\s:]+test_[\w.-]+\.py|[^\s:]+[\w.-]+_test\.py)/gi;

  for (const line of lines) {
    if (
      /(?:FAIL|FAILED|not ok|Error:|×|│\s*×)/i.test(line) &&
      !line.includes('ERR_PNPM_RECURSIVE')
    ) {
      let match;
      while ((match = fileCandidateRegex.exec(line)) !== null) {
        const file = match[1];
        if (file) {
          const norm = normalizeTaskPath(file);
          if (norm) found.add(norm);
        }
      }
    }
  }

  return Array.from(found);
}

export function isPathMatchedByExpectedTarget(
  actualPath: string,
  expectedPath: string,
): boolean {
  const normActual = normalizeTaskPath(actualPath) ?? actualPath;
  const normExpected = normalizeTaskPath(expectedPath) ?? expectedPath;

  if (normActual === normExpected) return true;
  if (normActual.endsWith('/' + normExpected) || normExpected.endsWith('/' + normActual)) {
    return true;
  }
  return false;
}

export interface ValidationRunCommandItem {
  command: ValidationCommand;
  outcome: string;
  kind?: string;
  stdoutPath?: string;
  stderrPath?: string;
}

export interface EvaluateRevalidationInput {
  validationRunCommands: ValidationRunCommandItem[];
  taskValidationCommands: ValidationCommand[];
  readTail: (filePath: string) => Promise<string>;
}

export interface EvaluateRevalidationResult {
  passed: boolean;
  failingCommands: ValidationRunCommandItem[];
}

export async function evaluateRevalidationWithInvertedCommands(
  input: EvaluateRevalidationInput,
): Promise<EvaluateRevalidationResult> {
  const { validationRunCommands, taskValidationCommands, readTail } = input;

  const failingCommands = validationRunCommands.filter((c) => c.outcome !== 'passed');
  if (failingCommands.length === 0) {
    return { passed: true, failingCommands: [] };
  }

  const invertedCommands = taskValidationCommands.filter(isNegatedValidationCommand);
  if (invertedCommands.length === 0) {
    return { passed: false, failingCommands };
  }

  const expectedFailingTestFiles = extractTargetTestFilesFromInvertedCommands(invertedCommands);
  if (expectedFailingTestFiles.length === 0) {
    return { passed: false, failingCommands };
  }

  const unexcusedFailing: ValidationRunCommandItem[] = [];

  for (const c of failingCommands) {
    if (isNegatedValidationCommand(c.command)) {
      unexcusedFailing.push(c);
      continue;
    }

    let logs = '';
    if (c.stdoutPath) {
      logs += (await readTail(c.stdoutPath)) + '\n';
    }
    if (c.stderrPath) {
      logs += (await readTail(c.stderrPath)) + '\n';
    }

    const actualFailedTestFiles = extractFailedTestFilesFromOutput(logs);
    if (actualFailedTestFiles.length === 0) {
      unexcusedFailing.push(c);
      continue;
    }

    const allAccountedFor = actualFailedTestFiles.every((actualPath) =>
      expectedFailingTestFiles.some((expectedPath) =>
        isPathMatchedByExpectedTarget(actualPath, expectedPath),
      ),
    );

    if (!allAccountedFor) {
      unexcusedFailing.push(c);
    }
  }

  return {
    passed: unexcusedFailing.length === 0,
    failingCommands: unexcusedFailing,
  };
}

export function checkRedTaskValidationParity(manifest: TaskManifest): string | null {
  if (manifest.version !== 2) return null;

  const diagnostics: string[] = [];

  const getNormalizedCommand = (cmd: ValidationCommand): string => {
    const arr = Array.isArray(cmd) ? cmd : [cmd];
    const joined = arr.join(' ').trim();
    return joined.replace(/\s+/g, ' ');
  };

  const isNegatedCommand = (cmd: ValidationCommand): boolean => {
    if (Array.isArray(cmd)) {
      return cmd[0]?.trim().startsWith('!') ?? false;
    }
    return String(cmd).trim().startsWith('!');
  };

  for (const task of manifest.tasks) {
    if (task.task_type === 'red') {
      const commands = task.validation_commands ?? [];

      const hasNegation = commands.some(isNegatedCommand);

      if (commands.length === 0 || !hasNegation) {
        diagnostics.push(
          `Task ${task.n}: task_type is 'red' but it lacks '! ' negation in its validation_commands.`,
        );
      }

      if (task.paired_with_task) {
        const pairedTask = manifest.tasks.find((t) => t.n === task.paired_with_task);
        if (pairedTask) {
          const pairedCommands = pairedTask.validation_commands ?? [];
          const taskNorms = commands.map(getNormalizedCommand);
          const pairedNorms = pairedCommands.map(getNormalizedCommand);

          const intersection = taskNorms.filter((cmd) => pairedNorms.includes(cmd));
          if (intersection.length > 0 && commands.length > 0) {
            diagnostics.push(
              `Task ${task.n}: RED task shares logically identical validation commands with its paired implementation Task ${task.paired_with_task}.`,
            );
          }
        }
      }
    }
  }

  if (diagnostics.length === 0) return null;
  return diagnostics.join('\n\n');
}

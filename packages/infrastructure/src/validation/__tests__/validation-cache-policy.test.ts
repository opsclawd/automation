import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ValidationCommand } from '@ai-sdlc/application/ports';
import { ProcessValidationAdapter } from '../validation-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = resolve(__dirname, './fixtures/validation-cache-env-fixture.mjs');

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'val-cache-'));
  tempDirs.push(dir);
  return dir;
}

function createFixtureCwd(): string {
  const cwd = freshDir();
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({
      scripts: {
        test: `node "${FIXTURE_PATH}" test`,
        typecheck: `node "${FIXTURE_PATH}" typecheck`,
        build: `node "${FIXTURE_PATH}" build`,
      },
    }),
  );
  return cwd;
}

function resolveRecordedPath(logDir: string, recordedPath: string): string {
  return join(logDir, recordedPath.replace(/^validate\//, ''));
}

describe('validation-cache-policy regressions', () => {
  let priorTurboForce: string | undefined;

  beforeEach(() => {
    priorTurboForce = process.env.TURBO_FORCE;
    delete process.env.TURBO_FORCE;
  });

  afterEach(() => {
    if (priorTurboForce !== undefined) {
      process.env.TURBO_FORCE = priorTurboForce;
    } else {
      delete process.env.TURBO_FORCE;
    }
  });

  it('forces bare test scripts to bypass Turbo cache', async () => {
    const logDir = freshDir();
    const cwd = createFixtureCwd();
    const adapter = new ProcessValidationAdapter();

    const results = await adapter.run({
      cwd,
      commands: ['pnpm test', 'pnpm run test'],
      timeoutSeconds: 30,
      logDir,
    });

    expect(results[0]?.stdout).toContain('test:TURBO_FORCE=true');
    expect(results[1]?.stdout).toContain('test:TURBO_FORCE=true');
  });

  it('forces string and argv typecheck scripts to bypass Turbo cache', async () => {
    const logDir = freshDir();
    const cwd = createFixtureCwd();
    const adapter = new ProcessValidationAdapter();

    const results = await adapter.run({
      cwd,
      commands: [
        'pnpm typecheck',
        'pnpm run typecheck',
        ['pnpm', 'typecheck'],
        ['pnpm', 'run', 'typecheck'],
      ] as ValidationCommand[],
      timeoutSeconds: 30,
      logDir,
    });

    expect(results[0]?.stdout).toContain('typecheck:TURBO_FORCE=true');
    expect(results[1]?.stdout).toContain('typecheck:TURBO_FORCE=true');
    expect(results[2]?.stdout).toContain('typecheck:TURBO_FORCE=true');
    expect(results[3]?.stdout).toContain('typecheck:TURBO_FORCE=true');
  });

  it('leaves build cache policy unchanged', async () => {
    const logDir = freshDir();
    const cwd = createFixtureCwd();
    const adapter = new ProcessValidationAdapter();

    const resultsUnset = await adapter.run({
      cwd,
      commands: ['pnpm build'],
      timeoutSeconds: 30,
      logDir,
    });

    expect(resultsUnset[0]?.stdout).toContain('build:TURBO_FORCE=<unset>');

    const resultsExplicit = await adapter.run({
      cwd,
      commands: ['pnpm build'],
      timeoutSeconds: 30,
      logDir,
      env: { TURBO_FORCE: 'false' },
    });

    expect(resultsExplicit[0]?.stdout).toContain('build:TURBO_FORCE=false');
  });

  it('overrides a false caller value for correctness gates only', async () => {
    const logDir = freshDir();
    const cwd = createFixtureCwd();
    const adapter = new ProcessValidationAdapter();

    const results = await adapter.run({
      cwd,
      commands: ['pnpm run test', 'pnpm run typecheck', 'pnpm build'],
      timeoutSeconds: 30,
      logDir,
      env: { TURBO_FORCE: 'false' },
    });

    expect(results[0]?.stdout).toContain('test:TURBO_FORCE=true');
    expect(results[1]?.stdout).toContain('typecheck:TURBO_FORCE=true');
    expect(results[2]?.stdout).toContain('build:TURBO_FORCE=false');
  });

  it('creates both recorded log files for an empty-output command', async () => {
    const logDir = freshDir();
    const adapter = new ProcessValidationAdapter();

    const [result] = await adapter.run({
      cwd: process.cwd(),
      commands: [[process.execPath, '-e', '']],
      timeoutSeconds: 30,
      logDir,
    });

    expect(readFileSync(resolveRecordedPath(logDir, result!.stdoutPath), 'utf8')).toBe('');
    expect(readFileSync(resolveRecordedPath(logDir, result!.stderrPath), 'utf8')).toBe('');
  });
});

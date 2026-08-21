import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { ValidationCommand } from '@ai-sdlc/application/ports';
import { ProcessValidationAdapter, commandSlug, bareScriptName } from '../validation-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = resolve(__dirname, './fixtures/validation-env-fixture.mjs');

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'val-adapter-'));
  tempDirs.push(dir);
  return dir;
}

describe('commandSlug', () => {
  it('strips pnpm prefix and normalizes', () => {
    expect(commandSlug('pnpm typecheck')).toBe('typecheck');
    expect(commandSlug('pnpm test:bash')).toBe('test-bash');
    expect(commandSlug('npm run build')).toBe('build');
    expect(commandSlug('node -e "process.exit(0)"')).toMatch(/^node/);
    expect(commandSlug('pnpm build')).toBe('build');
  });

  it('falls back to cmd for empty results', () => {
    expect(commandSlug('!!!')).toBe('cmd');
  });

  it('truncates at 40 characters; collisions are resolved by index prefix', () => {
    expect(commandSlug('pnpm aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(commandSlug('pnpm aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
  });
});

describe('bareScriptName', () => {
  it('extracts the script name from bare pnpm/pnpm run invocations', () => {
    expect(bareScriptName('pnpm test:bash')).toBe('test:bash');
    expect(bareScriptName('pnpm run test:bash')).toBe('test:bash');
    expect(bareScriptName('pnpm build')).toBe('build');
  });

  it('returns undefined for commands with extra arguments or chaining', () => {
    expect(bareScriptName('pnpm exec vitest run src/foo.test.ts')).toBeUndefined();
    expect(bareScriptName('DATABASE_URL=x pnpm exec vitest run src/foo.test.ts')).toBeUndefined();
    expect(bareScriptName('pnpm build && pnpm test')).toBeUndefined();
  });

  it('returns undefined for known pnpm builtin subcommands', () => {
    expect(bareScriptName('pnpm install')).toBeUndefined();
    expect(bareScriptName('pnpm exec')).toBeUndefined();
    expect(bareScriptName('pnpm why')).toBeUndefined();
  });
});

describe('ProcessValidationAdapter', () => {
  it('skips a bare pnpm <name> command when only a node_modules/.bin binary satisfies it', async () => {
    const logDir = freshDir();
    const cwd = freshDir();
    const binaryMarker = join(cwd, 'binary-ran');
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: {} }));
    mkdirSync(join(cwd, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(
      join(cwd, 'node_modules', '.bin', 'depcruise'),
      `#!/bin/sh\ntouch "${binaryMarker}"\n`,
      { mode: 0o755 },
    );

    const adapter = new ProcessValidationAdapter();
    const results = await adapter.run({
      cwd,
      commands: ['pnpm depcruise'],
      timeoutSeconds: 30,
      logDir,
    });

    expect(results[0].outcome).toBe('skipped');
    expect(results[0].exitCode).toBe(0);
    expect(results[0].stderr).toContain('no "depcruise" script in package.json');
    expect(existsSync(binaryMarker)).toBe(false);
  });

  it('executes declared scripts, skips missing scripts, and passes when every executed command passes', async () => {
    const logDir = freshDir();
    const cwd = freshDir();
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { build: 'echo built' } }));

    const adapter = new ProcessValidationAdapter();
    const results = await adapter.run({
      cwd,
      commands: ['pnpm test:bash', 'pnpm build'],
      timeoutSeconds: 30,
      logDir,
    });

    expect(results[0].outcome).toBe('skipped');
    expect(results[0].exitCode).toBe(0);
    expect(results[0].stderr).toContain('no "test:bash" script in package.json');
    expect(results[1].outcome).toBe('passed');
    expect(results[1].stdout).toContain('built');

    const summary = JSON.parse(readFileSync(join(logDir, 'validation-result.json'), 'utf-8'));
    expect(summary.passed).toBe(true);
  });

  it('fails the run when every command is skipped (nothing was verified)', async () => {
    const logDir = freshDir();
    const cwd = freshDir();
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: {} }));
    const adapter = new ProcessValidationAdapter();
    await adapter.run({
      cwd,
      commands: ['pnpm test:bash'],
      timeoutSeconds: 30,
      logDir,
    });
    const summary = JSON.parse(readFileSync(join(logDir, 'validation-result.json'), 'utf-8'));
    expect(summary.passed).toBe(false);
    expect(summary.commands[0].outcome).toBe('skipped');
  });

  it('runs every command without short-circuiting on failure', async () => {
    const logDir = freshDir();
    const adapter = new ProcessValidationAdapter();
    const results = await adapter.run({
      cwd: process.cwd(),
      commands: ['echo out; exit 0', 'echo boom >&2; exit 3', 'echo last; exit 0'],
      timeoutSeconds: 30,
      logDir,
    });
    expect(results).toHaveLength(3);
    expect(results[0].outcome).toBe('passed');
    expect(results[1].outcome).toBe('failed');
    expect(results[1].exitCode).toBe(3);
    expect(results[2].outcome).toBe('passed');
  });

  it('writes per-command stdout/stderr files and returns run-relative paths', async () => {
    const logDir = freshDir();
    const adapter = new ProcessValidationAdapter();
    const results = await adapter.run({
      cwd: process.cwd(),
      commands: ['echo hello; echo err >&2'],
      timeoutSeconds: 30,
      logDir,
    });
    const r = results[0];
    expect(r.stdoutPath.startsWith('validate/0-')).toBe(true);
    expect(r.stderrPath.startsWith('validate/0-')).toBe(true);
    const stdoutAbs = join(logDir, r.stdoutPath.replace(/^validate\//, ''));
    const stderrAbs = join(logDir, r.stderrPath.replace(/^validate\//, ''));
    expect(existsSync(stdoutAbs)).toBe(true);
    expect(readFileSync(stdoutAbs, 'utf-8')).toContain('hello');
    expect(existsSync(stderrAbs)).toBe(true);
    expect(readFileSync(stderrAbs, 'utf-8')).toContain('err');
  });

  // POSIX-only: the adapter kills by process group, and the command uses
  // POSIX shell syntax (`sleep`, `;`) that does not run under cmd.exe.
  it.skipIf(process.platform === 'win32')(
    'marks a command that exceeds the timeout as timed_out',
    async () => {
      const logDir = freshDir();
      const adapter = new ProcessValidationAdapter();
      const started = Date.now();
      const results = await adapter.run({
        cwd: process.cwd(),
        commands: ['sleep 5; echo done'],
        timeoutSeconds: 1,
        logDir,
      });
      expect(results[0].outcome).toBe('timed_out');
      // Proves the process-group kill actually freed us at the 1s timeout
      // rather than blocking until the 5s sleep finished on its own.
      expect(Date.now() - started).toBeLessThan(3000);
    },
  );

  it('writes a validation-result.json summary', async () => {
    const logDir = freshDir();
    const adapter = new ProcessValidationAdapter();
    await adapter.run({
      cwd: process.cwd(),
      commands: ['exit 0', 'exit 1'],
      timeoutSeconds: 30,
      logDir,
    });
    const summary = JSON.parse(readFileSync(join(logDir, 'validation-result.json'), 'utf-8'));
    expect(summary.passed).toBe(false);
    expect(summary.commands).toHaveLength(2);
    expect(summary.commands[0].outcome).toBe('passed');
    expect(summary.commands[1].outcome).toBe('failed');
    expect(summary.commands[0].stdoutPath).toMatch(/^validate\/0-/);
  });

  it('injects environment variables into the validation subprocess', async () => {
    const logDir = freshDir();
    const adapter = new ProcessValidationAdapter();
    const results = await adapter.run({
      cwd: process.cwd(),
      commands: ['echo $GITHUB_REPOSITORY'],
      timeoutSeconds: 30,
      logDir,
      env: {
        GITHUB_REPOSITORY: 'owner/repo-injected',
      },
    });
    expect(results[0].outcome).toBe('passed');
    expect(results[0].stdout.trim()).toBe('owner/repo-injected');
  });

  it('overlays the target repository while preserving inherited environment values', async () => {
    const logDir = freshDir();
    const adapter = new ProcessValidationAdapter();
    const priorSentinel = process.env.AI_SDLC_INHERITED_SENTINEL;
    try {
      process.env.AI_SDLC_INHERITED_SENTINEL = 'sentinel-preserved';
      const results = await adapter.run({
        cwd: process.cwd(),
        commands: [`node ${FIXTURE_PATH} owner/target-repo check TAIL_MARKER`],
        timeoutSeconds: 30,
        logDir,
        env: {
          GITHUB_REPOSITORY: 'owner/target-repo',
        },
      });
      expect(results[0].outcome).toBe('passed');
      expect(results[0].stdout).toContain('Repository=owner/target-repo');
      expect(results[0].stdout).toContain('Sentinel=sentinel-preserved');
    } finally {
      if (priorSentinel !== undefined) {
        process.env.AI_SDLC_INHERITED_SENTINEL = priorSentinel;
      } else {
        delete process.env.AI_SDLC_INHERITED_SENTINEL;
      }
    }
  });

  it('regression: fixture rejects ambient mismatched repository and passes with explicit override', async () => {
    const logDir = freshDir();
    const adapter = new ProcessValidationAdapter();
    const priorRepo = process.env.GITHUB_REPOSITORY;
    const priorSentinel = process.env.AI_SDLC_INHERITED_SENTINEL;
    try {
      process.env.GITHUB_REPOSITORY = 'owner/wrong-repository';
      process.env.AI_SDLC_INHERITED_SENTINEL = 'sentinel-preserved';
      const resultsAmbient = await adapter.run({
        cwd: process.cwd(),
        commands: [`node ${FIXTURE_PATH} owner/expected-repository check TAIL_MARKER`],
        timeoutSeconds: 30,
        logDir,
      });
      expect(resultsAmbient[0].outcome).toBe('failed');
      expect(resultsAmbient[0].stderr).toContain('repository_mismatch');

      const resultsOverride = await adapter.run({
        cwd: process.cwd(),
        commands: [`node ${FIXTURE_PATH} owner/expected-repository check TAIL_MARKER`],
        timeoutSeconds: 30,
        logDir,
        env: {
          GITHUB_REPOSITORY: 'owner/expected-repository',
        },
      });
      expect(resultsOverride[0].outcome).toBe('passed');
      expect(resultsOverride[0].stdout).toContain('Repository=owner/expected-repository');
      expect(resultsOverride[0].stdout).toContain('Sentinel=sentinel-preserved');
    } finally {
      if (priorRepo !== undefined) {
        process.env.GITHUB_REPOSITORY = priorRepo;
      } else {
        delete process.env.GITHUB_REPOSITORY;
      }
      if (priorSentinel !== undefined) {
        process.env.AI_SDLC_INHERITED_SENTINEL = priorSentinel;
      } else {
        delete process.env.AI_SDLC_INHERITED_SENTINEL;
      }
    }
  });

  it('executes argv validation commands without shell expansion', async () => {
    const logDir = freshDir();
    const adapter = new ProcessValidationAdapter();
    const bracketedPath = 'apps/app/app/position/[id].tsx';
    const results = await adapter.run({
      cwd: process.cwd(),
      commands: [
        [process.execPath, '-e', 'console.log(process.argv[1])', bracketedPath],
      ] as ValidationCommand[],
      timeoutSeconds: 30,
      logDir,
    });
    expect(results[0].outcome).toBe('passed');
    expect(results[0].stdout.trim()).toBe(bracketedPath);
    expect(results[0].command).toBe(
      `${process.execPath} -e console.log(process.argv[1]) ${bracketedPath}`,
    );
  });

  it('continues to execute legacy string validation commands through the shell', async () => {
    const logDir = freshDir();
    const adapter = new ProcessValidationAdapter();
    const results = await adapter.run({
      cwd: process.cwd(),
      commands: ['echo $GITHUB_REPOSITORY; echo legacy-shell-active'],
      timeoutSeconds: 30,
      logDir,
      env: {
        GITHUB_REPOSITORY: 'owner/legacy-repo',
      },
    });
    expect(results[0].outcome).toBe('passed');
    expect(results[0].stdout).toContain('owner/legacy-repo');
    expect(results[0].stdout).toContain('legacy-shell-active');
  });

  it('classifies an unmatched legacy shell quote as parse_error', async () => {
    const logDir = freshDir();
    const adapter = new ProcessValidationAdapter();
    const results = await adapter.run({
      cwd: process.cwd(),
      commands: ["printf '%s\\n' 'unterminated"],
      timeoutSeconds: 30,
      logDir,
    });
    expect(results[0].exitCode).toBe(2);
    expect(results[0].outcome).toBe('parse_error');
  });

  it('keeps an ordinary exit code 2 tool failure as failed', async () => {
    const logDir = freshDir();
    const adapter = new ProcessValidationAdapter();
    const results = await adapter.run({
      cwd: process.cwd(),
      commands: [`${process.execPath} -e "process.exit(2)"`],
      timeoutSeconds: 30,
      logDir,
    });
    expect(results[0].exitCode).toBe(2);
    expect(results[0].outcome).toBe('failed');
  });

  it('does not classify argv stderr as a shell parse error', async () => {
    const logDir = freshDir();
    const adapter = new ProcessValidationAdapter();
    const results = await adapter.run({
      cwd: process.cwd(),
      commands: [
        [process.execPath, '-e', "process.stderr.write('syntax error'); process.exit(2)"],
      ] as ValidationCommand[],
      timeoutSeconds: 30,
      logDir,
    });
    expect(results[0].exitCode).toBe(2);
    expect(results[0].outcome).toBe('failed');
  });

  it.skipIf(process.platform === 'win32')(
    'keeps timeout precedence over shell parse detection',
    async () => {
      const logDir = freshDir();
      const adapter = new ProcessValidationAdapter();
      const results = await adapter.run({
        cwd: process.cwd(),
        commands: ['sh -c "echo \'syntax error\' >&2; sleep 5"'],
        timeoutSeconds: 1,
        logDir,
      });
      expect(results[0].outcome).toBe('timed_out');
    },
  );

  describe('tiers execution', () => {
    it('runs commands in parallel via Promise.all when a single tier is provided', async () => {
      const logDir = freshDir();
      const adapter = new ProcessValidationAdapter();
      const results = await adapter.run({
        cwd: process.cwd(),
        commands: ['echo cmd1', 'echo cmd2', 'echo cmd3'],
        tiers: [['echo cmd1', 'echo cmd2', 'echo cmd3']],
        timeoutSeconds: 30,
        logDir,
      });

      expect(results).toHaveLength(3);
      expect(results[0].command).toBe('echo cmd1');
      expect(results[1].command).toBe('echo cmd2');
      expect(results[2].command).toBe('echo cmd3');
      expect(results[0].outcome).toBe('passed');
      expect(results[1].outcome).toBe('passed');
      expect(results[2].outcome).toBe('passed');

      const summary = JSON.parse(readFileSync(join(logDir, 'validation-result.json'), 'utf-8'));
      expect(summary.passed).toBe(true);
      expect(summary.commands).toHaveLength(3);
      expect(summary.commands[0].stdoutPath).toMatch(/^validate\/0-/);
      expect(summary.commands[1].stdoutPath).toMatch(/^validate\/1-/);
      expect(summary.commands[2].stdoutPath).toMatch(/^validate\/2-/);
    });

    it('runs tiers sequentially and commands within each tier in parallel when multiple tiers are provided', async () => {
      const logDir = freshDir();
      const adapter = new ProcessValidationAdapter();
      const results = await adapter.run({
        cwd: process.cwd(),
        commands: ['echo tier1-cmd1', 'echo tier1-cmd2', 'echo tier2-cmd1'],
        tiers: [
          ['echo tier1-cmd1', 'echo tier1-cmd2'],
          ['echo tier2-cmd1'],
        ],
        timeoutSeconds: 30,
        logDir,
      });

      expect(results).toHaveLength(3);
      expect(results[0].command).toBe('echo tier1-cmd1');
      expect(results[1].command).toBe('echo tier1-cmd2');
      expect(results[2].command).toBe('echo tier2-cmd1');
      expect(results[0].outcome).toBe('passed');
      expect(results[1].outcome).toBe('passed');
      expect(results[2].outcome).toBe('passed');
    });

    it('appends undeclared extra commands from commands array as a final tier', async () => {
      const logDir = freshDir();
      const adapter = new ProcessValidationAdapter();
      const results = await adapter.run({
        cwd: process.cwd(),
        commands: ['echo tier1-cmd1', 'echo extra-cmd'],
        tiers: [['echo tier1-cmd1']],
        timeoutSeconds: 30,
        logDir,
      });

      expect(results).toHaveLength(2);
      expect(results[0].command).toBe('echo tier1-cmd1');
      expect(results[1].command).toBe('echo extra-cmd');
      expect(results[0].outcome).toBe('passed');
      expect(results[1].outcome).toBe('passed');
    });
  });
});

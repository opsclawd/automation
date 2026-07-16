import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessValidationAdapter, commandSlug } from '../validation-adapter.js';

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

describe('ProcessValidationAdapter', () => {
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
});

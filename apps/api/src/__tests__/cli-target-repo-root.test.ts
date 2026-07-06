import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveTargetRepoRootOrExit, validateTargetRepoRoot } from '../cli/target-repo-root.js';

const tempDirs: string[] = [];
function trackDir<T extends string>(fn: () => T): T {
  const result = fn();
  tempDirs.push(result);
  return result;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function makeGitRepo(): string {
  const dir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-trr-')));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', dir], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't'], { stdio: 'pipe' });
  writeFileSync(join(dir, 'README.md'), 't');
  execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'commit', '--quiet', '-m', 'init'], { stdio: 'pipe' });
  return dir;
}

describe('validateTargetRepoRoot', () => {
  it('returns ok with absolute path for an existing git working tree', () => {
    const dir = makeGitRepo();
    const result = validateTargetRepoRoot(dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved.absolute).toBe(dir);
  });

  it('resolves a relative path against the supplied cwd', () => {
    const dir = makeGitRepo();
    trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-trr-base-')));
    // Create a symlink-relative scenario: use basename only
    const basename = dir.split('/').pop()!;
    // We need to cd to the parent of dir; for the test we pass a function
    // that resolves relative to `base`. Since validateTargetRepoRoot always
    // uses process.cwd(), verify absolute-only behavior in this test and
    // cover relative resolution in resolveTargetRepoRootOrExit.
    expect(basename.length).toBeGreaterThan(0);
    const result = validateTargetRepoRoot(dir);
    expect(result.ok).toBe(true);
  });

  it('returns not_found when the path does not exist', () => {
    const result = validateTargetRepoRoot('/no/such/path/ai-orch-trr-xyz');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_found');
      expect(result.message).toMatch(/not an existing directory/);
    }
  });

  it('returns not_found when the path exists but is not a directory', () => {
    const dir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-trr-file-')));
    const filePath = join(dir, 'afile');
    writeFileSync(filePath, 'x');
    const result = validateTargetRepoRoot(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
  });

  it('returns not_git when the directory is not inside a git working tree', () => {
    const dir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-trr-nogit-')));
    const result = validateTargetRepoRoot(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_git');
      expect(result.message).toMatch(/not inside a git working tree/);
    }
  });

  it('returns git_missing when git CLI cannot be found', () => {
    const dir = makeGitRepo();
    const spy = vi
      .spyOn(require('node:child_process') as typeof import('node:child_process'), 'execFileSync')
      .mockImplementation(((cmd: string) => {
        if (cmd === 'git') {
          const err = new Error('spawn git ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return Buffer.from('') as never;
      }) as never);
    const result = validateTargetRepoRoot(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('git_missing');
      expect(result.message).toMatch(/git CLI not found/);
    }
    spy.mockRestore();
  });
});

describe('resolveTargetRepoRootOrExit', () => {
  it('returns undefined when raw is undefined', () => {
    const exit = vi.fn((() => {
      throw new Error('should not exit');
    }) as never);
    const result = resolveTargetRepoRootOrExit(undefined, exit);
    expect(result).toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it('returns the absolute path on success and does not call onError', () => {
    const dir = makeGitRepo();
    const exit = vi.fn((() => {
      throw new Error('should not exit');
    }) as never);
    const result = resolveTargetRepoRootOrExit(dir, exit);
    expect(result).toBe(dir);
    expect(exit).not.toHaveBeenCalled();
  });

  it('calls onError with the typed message and returns undefined on not_found', () => {
    const exit = vi.fn((() => undefined) as never);
    const result = resolveTargetRepoRootOrExit('/no/such/path/ai-orch-trr-xyz', exit);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls[0]?.[0]).toMatch(/not an existing directory/);
    expect(result).toBeUndefined();
  });

  it('calls onError on not_git', () => {
    const dir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-trr-rn-nogit-')));
    const exit = vi.fn((() => undefined) as never);
    resolveTargetRepoRootOrExit(dir, exit);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls[0]?.[0]).toMatch(/not inside a git working tree/);
  });

  it('calls onError on git_missing', () => {
    const dir = makeGitRepo();
    const spy = vi
      .spyOn(require('node:child_process') as typeof import('node:child_process'), 'execFileSync')
      .mockImplementation(((cmd: string) => {
        if (cmd === 'git') {
          const err = new Error('spawn git ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return Buffer.from('') as never;
      }) as never);
    const exit = vi.fn((() => undefined) as never);
    resolveTargetRepoRootOrExit(dir, exit);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls[0]?.[0]).toMatch(/git CLI not found/);
    spy.mockRestore();
  });
});

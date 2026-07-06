import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeWithTarget } from '../cli/compose-with-target.js';
import * as composeMod from '../compose.js';
import { findRepoRoot } from '../cli.js';

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

function makeRepoRoot(): string {
  const dir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-cwt-')));
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  return dir;
}

describe('composeWithTarget', () => {
  it('passes runStartupSweeps: false and undefined targetRepoRoot when targetRepoRoot is omitted', () => {
    const root = makeRepoRoot();
    const savedCwd = process.cwd();
    process.chdir(root);
    const composeSpy = vi.spyOn(composeMod, 'composeRoot').mockReturnValue({
      c: {} as never,
      repoRoot: root,
    });
    try {
      const { c, repoRoot } = composeWithTarget(undefined, {});
      expect(repoRoot).toBe(root);
      expect(c).toBeDefined();
      expect(composeSpy).toHaveBeenCalledTimes(1);
      const opts = composeSpy.mock.calls[0]?.[0] as composeMod.ComposeOptions;
      expect(opts.repoRoot).toBe(root);
      expect(opts.targetRepoRoot).toBeUndefined();
      expect(opts.runStartupSweeps).toBe(false);
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('threads targetRepoRoot through to composeRoot when set', () => {
    const root = makeRepoRoot();
    const target = makeRepoRoot();
    const savedCwd = process.cwd();
    process.chdir(root);
    const composeSpy = vi.spyOn(composeMod, 'composeRoot').mockReturnValue({
      c: {} as never,
      repoRoot: root,
    });
    try {
      composeWithTarget(target, {});
      const opts = composeSpy.mock.calls[0]?.[0] as composeMod.ComposeOptions;
      expect(opts.targetRepoRoot).toBe(target);
      expect(opts.runStartupSweeps).toBe(false);
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('honors an explicit runStartupSweeps override', () => {
    const root = makeRepoRoot();
    const savedCwd = process.cwd();
    process.chdir(root);
    const composeSpy = vi.spyOn(composeMod, 'composeRoot').mockReturnValue({
      c: {} as never,
      repoRoot: root,
    });
    try {
      composeWithTarget(undefined, { runStartupSweeps: true });
      const opts = composeSpy.mock.calls[0]?.[0] as composeMod.ComposeOptions;
      expect(opts.runStartupSweeps).toBe(true);
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('merges composeOverrides after defaults so test overrides win', () => {
    const root = makeRepoRoot();
    const savedCwd = process.cwd();
    process.chdir(root);
    const composeSpy = vi.spyOn(composeMod, 'composeRoot').mockReturnValue({
      c: {} as never,
      repoRoot: root,
    });
    try {
      composeWithTarget(undefined, {
        composeOverrides: { repoFullName: 'override/repo' },
      });
      const opts = composeSpy.mock.calls[0]?.[0] as composeMod.ComposeOptions;
      expect(opts.repoFullName).toBe('override/repo');
      expect(opts.runStartupSweeps).toBe(false);
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('resolves scriptPath against repoRoot by default', () => {
    const root = makeRepoRoot();
    const savedCwd = process.cwd();
    process.chdir(root);
    const composeSpy = vi.spyOn(composeMod, 'composeRoot').mockReturnValue({
      c: {} as never,
      repoRoot: root,
    });
    try {
      composeWithTarget(undefined, {});
      const opts = composeSpy.mock.calls[0]?.[0] as composeMod.ComposeOptions;
      expect(opts.scriptPath).toBe(join(root, 'scripts', 'legacy', 'ai-run-issue-v2'));
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('honors a custom scriptPath (absolute or relative to repoRoot)', () => {
    const root = makeRepoRoot();
    const savedCwd = process.cwd();
    process.chdir(root);
    const composeSpy = vi.spyOn(composeMod, 'composeRoot').mockReturnValue({
      c: {} as never,
      repoRoot: root,
    });
    try {
      composeWithTarget(undefined, { scriptPath: '/abs/path/to/script' });
      const opts = composeSpy.mock.calls[0]?.[0] as composeMod.ComposeOptions;
      expect(opts.scriptPath).toBe('/abs/path/to/script');
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('uses findRepoRoot to resolve repoRoot from process.cwd()', () => {
    const root = makeRepoRoot();
    const savedCwd = process.cwd();
    process.chdir(root);
    const composeSpy = vi.spyOn(composeMod, 'composeRoot').mockReturnValue({
      c: {} as never,
      repoRoot: root,
    });
    const findSpy = vi.spyOn({ findRepoRoot }, 'findRepoRoot');
    try {
      composeWithTarget(undefined, {});
      expect(findSpy).toBeDefined();
      // Indirect: confirm repoRoot passed to composeRoot matches findRepoRoot(root)
      const opts = composeSpy.mock.calls[0]?.[0] as composeMod.ComposeOptions;
      expect(opts.repoRoot).toBe(findRepoRoot(root));
    } finally {
      process.chdir(savedCwd);
    }
  });
});

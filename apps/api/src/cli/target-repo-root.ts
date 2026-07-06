import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');

export interface ResolvedTargetRepoRoot {
  absolute: string;
}

export type TargetRepoRootValidation =
  | { ok: true; resolved: ResolvedTargetRepoRoot }
  | {
      ok: false;
      code: 'not_found' | 'not_git' | 'git_missing';
      message: string;
    };

/**
 * Validate that `raw` is an existing directory inside a git working tree.
 * Relative paths are resolved against `process.cwd()` to match the existing
 * `run` command behavior (apps/api/src/cli.ts inline block).
 */
export function validateTargetRepoRoot(raw: string): TargetRepoRootValidation {
  const absolute = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    return {
      ok: false,
      code: 'not_found',
      message: `--target-repo-root is not an existing directory: ${absolute}`,
    };
  }
  try {
    cp.execFileSync('git', ['-C', absolute, 'rev-parse', '--git-dir'], { stdio: 'pipe' });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        code: 'git_missing',
        message: 'git CLI not found; cannot validate --target-repo-root.',
      };
    }
    return {
      ok: false,
      code: 'not_git',
      message: `--target-repo-root is not inside a git working tree: ${absolute}`,
    };
  }
  return { ok: true, resolved: { absolute } };
}

/**
 * If `raw` is undefined, return undefined (flag omitted → no change).
 * Otherwise validate and either return the absolute path or invoke `onError`
 * with the typed message and return undefined. `onError` is expected to
 * print and `process.exit(1)`; this helper does not import `process` to keep
 * the validation pipeline unit-testable.
 */
export function resolveTargetRepoRootOrExit(
  raw: string | undefined,
  onError: (message: string) => never,
): string | undefined {
  if (raw === undefined) return undefined;
  const result = validateTargetRepoRoot(raw);
  if (!result.ok) {
    return onError(result.message);
  }
  return result.resolved.absolute;
}

export function findRepoRoot(
  startDir: string,
  exists: (p: string) => boolean = existsSync,
): string {
  let dir = startDir;
  for (;;) {
    if (exists(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return startDir;
    }
    dir = parent;
  }
}

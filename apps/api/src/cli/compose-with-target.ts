import { isAbsolute, join, resolve } from 'node:path';
import { composeRoot, type ComposeOptions } from '../compose.js';
import type { Container } from '../compose.js';
import { findRepoRoot } from '../cli.js';
import type { BuildProgramOptions } from '../cli.js';

export interface ComposeWithTargetOptions {
  buildOpts?: BuildProgramOptions;
  scriptPath?: string;
  /** Override `runStartupSweeps` (default: false — matches the current
   *  behavior of every management command). Pass `true` from `run`. */
  runStartupSweeps?: boolean;
  composeOverrides?: Partial<ComposeOptions>;
}

export interface ComposeWithTargetResult {
  c: Container;
  repoRoot: string;
}

/**
 * Resolve `repoRoot` from `process.cwd()`, build `ComposeOptions` with
 * `runStartupSweeps: false` by default, and thread `targetRepoRoot` through.
 * `buildOpts?.composeOverrides` are merged last so test overrides win.
 */
export function composeWithTarget(
  targetRepoRoot: string | undefined,
  options: ComposeWithTargetOptions = {},
): ComposeWithTargetResult {
  const repoRoot = findRepoRoot(process.cwd());
  const { buildOpts, scriptPath: customScriptPath, runStartupSweeps, composeOverrides } = options;
  const scriptPath = customScriptPath
    ? isAbsolute(customScriptPath)
      ? customScriptPath
      : resolve(repoRoot, customScriptPath)
    : join(repoRoot, 'scripts', 'legacy', 'ai-run-issue-v2');
  const composeOptions: ComposeOptions = {
    repoRoot,
    scriptPath,
    runStartupSweeps: runStartupSweeps ?? false,
    ...buildOpts?.composeOverrides,
    ...composeOverrides,
  };
  if (targetRepoRoot !== undefined) {
    composeOptions.targetRepoRoot = targetRepoRoot;
  }
  const c = composeRoot(composeOptions);
  return { c, repoRoot };
}

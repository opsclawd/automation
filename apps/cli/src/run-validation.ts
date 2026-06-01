#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { composeRoot } from '@ai-sdlc/api/compose.js';
import { RunId, PhaseName } from '@ai-sdlc/domain';
import { ConfigError, loadConfig } from '@ai-sdlc/shared';

interface Flags {
  cwd?: string;
  'run-id'?: string;
  'repo-id'?: string;
  'repo-root'?: string;
  'phase-id'?: string;
}

export function validateRequiredFlags(values: Flags): string[] {
  const missing: string[] = [];
  if (!values.cwd) missing.push('--cwd');
  if (!values['run-id']) missing.push('--run-id');
  if (!values['repo-root']) missing.push('--repo-root');
  return missing;
}

/** Validation pass/fail maps to a binary exit code the Bash caller branches on. */
export function exitCodeForValidation(passed: boolean): number {
  return passed ? 0 : 1;
}

/** Walk up from `dir` to find the repo root (containing pnpm-workspace.yaml). */
function findRepoRoot(dir: string): string {
  let current = resolve(dir);
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  console.error('could not find repo root (no pnpm-workspace.yaml found)');
  process.exit(2);
}

/**
 * run-validation CLI
 *
 * Exit codes:
 *   0 — validation passed
 *   1 — validation failed (>=1 command failed/timed out)
 *   2 — config error (missing flags / no .ai-orchestrator.json / no commands)
 *   3 — unexpected error
 *
 * Usage (from Bash):
 *   NODE_OPTIONS='--conditions=development' node --import "$_TSX_LOADER" \
 *     apps/cli/src/run-validation.ts \
 *     --cwd <worktree> --run-id <uuid> --repo-id <owner/repo> \
 *     --repo-root <canonical-repo-root> --phase-id validate
 *
 * runStartupSweeps:false is mandatory (issue #107): composing inside a child
 * process must not sweep tmp dirs out from under running work.
 */
async function main() {
  const { values } = parseArgs({
    options: {
      cwd: { type: 'string' },
      'run-id': { type: 'string' },
      'repo-id': { type: 'string' },
      'repo-root': { type: 'string' },
      'phase-id': { type: 'string' },
    },
    allowPositionals: false,
  }) as { values: Flags };

  const missing = validateRequiredFlags(values);
  if (missing.length > 0) {
    console.error(`missing required flag(s): ${missing.join(', ')}`);
    process.exit(2);
  }

  const repoRoot = values['repo-root'] ?? findRepoRoot(values.cwd!);

  let config;
  try {
    config = loadConfig(repoRoot);
  } catch (err) {
    if (err instanceof ConfigError && (err.cause as { code?: string })?.code === 'ENOENT') {
      console.error('no .ai-orchestrator.json found at repo root');
      process.exit(2);
    }
    throw err;
  }

  const c = composeRoot({ repoRoot, scriptPath: '/dev/null', runStartupSweeps: false });

  const runId = values['run-id']!;
  const phaseId = values['phase-id'] ?? 'validate';
  const displayId = c.runRepository.findByUuid(runId)?.displayId ?? runId;
  const logDir = join(c.runsDir, displayId, 'validate');

  try {
    const { validationRun, passed } = await c.runValidation.execute({
      runId: RunId(runId),
      phaseId: PhaseName(phaseId),
      cwd: values.cwd!,
      logDir,
      commands: config.validation.commands,
      timeoutSeconds: config.validation.timeout,
    });

    for (const cmd of validationRun.commands) {
      // eslint-disable-next-line no-console
      console.log(`[${cmd.outcome}] ${cmd.command} (${cmd.durationMs}ms, exit ${cmd.exitCode})`);
    }
    // eslint-disable-next-line no-console
    console.log(passed ? 'validation: PASSED' : 'validation: FAILED');
    process.exit(exitCodeForValidation(passed));
  } catch (e) {
    if (e instanceof Error && /no validation commands/i.test(e.message)) {
      console.error(e.message);
      process.exit(2);
    }
    console.error(e);
    process.exit(3);
  }
}

if (!process.env.VITEST) {
  void main();
}

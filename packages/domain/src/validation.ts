import type { RunId, PhaseName } from './ids.js';

export type ValidationCommandOutcome = 'passed' | 'failed' | 'timed_out' | 'skipped';

export type ValidationCommandKind = 'build' | 'lint' | 'typecheck' | 'test' | 'other';

/**
 * A persisted per-command result. Large output lives on disk; we store
 * run-directory-relative paths (e.g. "validate/2-typecheck.stdout.log").
 *
 * NOTE: distinct from the transient `ValidationCommandResult` in
 * packages/application/src/ports/validation-port.ts, which carries inline
 * stdout/stderr strings. This is the *persisted* record. M5-02 maps
 * the former into the latter.
 */
export interface ValidationCommandRecord {
  command: string;
  exitCode: number;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  outcome: ValidationCommandOutcome;
  kind?: ValidationCommandKind;
  classifier?: string;
}

export interface ValidationRun {
  id: string;
  runId: RunId;
  phaseId: PhaseName;
  commands: ValidationCommandRecord[];
  startedAt: Date;
  completedAt?: Date;
}

/**
 * A ValidationRun passes iff it has at least one executed (non-`skipped`)
 * command and every executed command passed. `skipped` commands (e.g. a
 * configured `pnpm <script>` whose script doesn't exist in this repo's
 * package.json) are excluded from the pass/fail computation entirely — they
 * neither pass nor fail the run. A command list that is empty, or where
 * every command was skipped, is NOT a pass (nothing was actually verified).
 */
export function validationRunPassed(v: ValidationRun): boolean {
  const executed = v.commands.filter((c) => c.outcome !== 'skipped');
  return executed.length > 0 && executed.every((c) => c.outcome === 'passed');
}

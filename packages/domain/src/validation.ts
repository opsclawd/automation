import type { RunId, PhaseName } from './ids.js';

export type ValidationCommandOutcome = 'passed' | 'failed' | 'timed_out';

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
 * A ValidationRun passes iff it has at least one command and every command
 * passed. An empty command list is NOT a pass (surface as a config error
 * upstream in M5-02).
 */
export function validationRunPassed(v: ValidationRun): boolean {
  return v.commands.length > 0 && v.commands.every((c) => c.outcome === 'passed');
}

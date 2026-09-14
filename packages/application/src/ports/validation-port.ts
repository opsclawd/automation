import type { ValidationCommandOutcome } from '@ai-sdlc/domain';
export interface ValidationCommandResult {
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutPath: string;
  stderrPath: string;
  outcome: ValidationCommandOutcome;
}
export type ValidationCommand = string | string[];
export type ValidationScopeSummary =
  | { validationMode: 'full' }
  | { validationMode: 'narrow'; narrowedPackages: string[] };
export interface RunValidationInput {
  cwd: string;
  commands: ValidationCommand[];
  tiers?: string[][];
  timeoutSeconds: number;
  logDir: string;
  logPathPrefix?: string;
  env?: Record<string, string>;
  validationScope?: ValidationScopeSummary;
  /** Max commands run concurrently within a single tier. Overrides the
   *  adapter's own default (host CPU core count) when set. */
  maxTierConcurrency?: number;
}
export interface ValidationPort {
  run(input: RunValidationInput): Promise<ValidationCommandResult[]>;
}

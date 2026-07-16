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
export interface RunValidationInput {
  cwd: string;
  commands: string[];
  timeoutSeconds: number;
  logDir: string;
  logPathPrefix?: string;
  env?: Record<string, string>;
}
export interface ValidationPort {
  run(input: RunValidationInput): Promise<ValidationCommandResult[]>;
}

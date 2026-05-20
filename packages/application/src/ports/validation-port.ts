export interface ValidationCommandResult {
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface RunValidationInput {
  cwd: string;
  commands: string[];
  timeoutSeconds: number;
}

export interface ValidationPort {
  run(input: RunValidationInput): Promise<ValidationCommandResult[]>;
}

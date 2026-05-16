import type { Run, RunStatus, Failure } from '@ai-sdlc/domain';

export interface RunRepositoryUpdatePatch {
  status?: RunStatus;
  currentPhase?: string | null;
  completedPhases?: string[];
  completedAt?: Date;
  failureReason?: string;
  exitCode?: number;
  durationMs?: number;
}

export interface RunRepositoryPort {
  insertIfNoActive(run: Run): void;
  update(uuid: string, patch: RunRepositoryUpdatePatch): void;
}

export interface RunDirectoryHandle {
  readonly runRoot: string;
  readonly paths: {
    readonly stdoutLogPath: string;
    readonly stderrLogPath: string;
    readonly combinedLogPath: string;
  };
  writeRunJson(run: Run): void;
  writeFailureJson(failure: Failure): void;
  readCombinedLog(): string;
}

export type RunDirectoryFactory = (input: { rootDir: string; run: Run }) => RunDirectoryHandle;

export interface RunBashScriptInput {
  scriptPath: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  stdoutPath: string;
  stderrPath: string;
  combinedPath: string;
}

export interface RunBashScriptResult {
  exitCode: number;
  durationMs: number;
}

export type RunBashScriptFn = (input: RunBashScriptInput) => Promise<RunBashScriptResult>;

export interface ClassifyExitInput {
  exitCode: number;
  combinedLogTail: string;
  runUuid?: string;
  artifacts?: string[];
  detectedAt?: Date;
}

export type ClassifyExitFn = (input: ClassifyExitInput) => Failure;

export interface FailureRepositoryPort {
  insert(failure: Failure): void;
  findLatestByRun(runUuid: string): Failure | undefined;
}

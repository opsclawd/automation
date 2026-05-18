import type { Run, RunStatus, Failure, ClassifyExitInput } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

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
    readonly eventsJsonlPath: string;
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
  tee?: boolean;
}

export interface RunBashScriptResult {
  exitCode: number;
  durationMs: number;
}

export type RunBashScriptFn = (input: RunBashScriptInput) => Promise<RunBashScriptResult>;

export type { ClassifyExitInput } from '@ai-sdlc/domain';

export type ClassifyExitFn = (input: ClassifyExitInput) => Failure;

export interface FailureRepositoryPort {
  insert(failure: Failure): void;
  findLatestByRun(runUuid: string): Failure | undefined;
}

export interface EventRepositoryPort {
  insert(event: {
    runUuid: string;
    phase?: string | undefined;
    level: string;
    type: string;
    message: string;
    metadata?: Record<string, unknown>;
    timestamp: Date;
  }): number;
  listByRunSince(
    runUuid: string,
    sinceIso?: string,
  ): Array<{
    id: number;
    runUuid: string;
    phase?: string | undefined;
    level: string;
    type: string;
    message: string;
    metadata: Record<string, unknown>;
    timestamp: Date;
  }>;
}

export interface EventBusPort {
  subscribe(runUuid: string, listener: (event: OrchestratorEvent) => void): () => void;
  publish(runUuid: string, event: OrchestratorEvent): void;
}

export type EventTailerFactory = (input: {
  path: string;
  onEvent: (event: OrchestratorEvent) => void;
  onParseError: (err: Error, line: string) => void;
}) => {
  start(): Promise<void>;
  drainAndStop(): Promise<void>;
  stop(): Promise<void>;
};

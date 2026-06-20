import type { RunId } from '@ai-sdlc/domain';

export interface RunAbortPort {
  /**
   * Register a run's abort controller along with a `done` promise that resolves
   * when the run's process has fully exited. `abort()` aborts the controller and
   * then awaits `done`, so cleanup only runs after the agent has stopped writing.
   */
  register(runId: RunId, controller: AbortController, done: Promise<void>): void;
  abort(runId: RunId): Promise<void>;
  unregister(runId: RunId): void;
}

import type { RunId } from '@ai-sdlc/domain';

export interface RunAbortPort {
  register(runId: RunId, controller: AbortController): void;
  abort(runId: RunId): void;
  unregister(runId: RunId): void;
}

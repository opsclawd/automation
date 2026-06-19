import type { RunId } from '@ai-sdlc/domain';
import type { RunAbortPort } from '../ports/run-abort-port.js';

export class FakeRunAbortPort implements RunAbortPort {
  private controllers = new Map<RunId, AbortController>();
  calls: Array<{ method: 'register' | 'abort' | 'unregister'; runId: string }> = [];

  register(runId: RunId, controller: AbortController): void {
    this.calls.push({ method: 'register', runId });
    this.controllers.set(runId, controller);
  }

  abort(runId: RunId): void {
    this.calls.push({ method: 'abort', runId });
    const ctrl = this.controllers.get(runId);
    if (ctrl) ctrl.abort();
  }

  unregister(runId: RunId): void {
    this.calls.push({ method: 'unregister', runId });
    this.controllers.delete(runId);
  }
}

import type { RunId, Loop } from '@ai-sdlc/domain';
import type { LoopRepositoryPort } from '../ports/loop-repository-port.js';

function clone(loop: Loop): Loop {
  return {
    ...loop,
    iterations: loop.iterations.map((it) => ({ ...it })),
  };
}

export class FakeLoopRepository implements LoopRepositoryPort {
  private readonly loops = new Map<string, Loop>();

  insert(loop: Loop): void {
    this.loops.set(loop.id, clone(loop));
  }

  update(loop: Loop): void {
    this.loops.set(loop.id, clone(loop));
  }

  findById(id: string): Loop | undefined {
    const found = this.loops.get(id);
    return found ? clone(found) : undefined;
  }

  listForRun(runId: RunId): Loop[] {
    return [...this.loops.values()].filter((l) => l.runId === runId).map(clone);
  }
}

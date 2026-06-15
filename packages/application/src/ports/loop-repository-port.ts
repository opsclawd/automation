import type { RunId, Loop } from '@ai-sdlc/domain';

export interface LoopRepositoryPort {
  /** Insert a new loop and its iterations. */
  insert(loop: Loop): void;
  /** Upsert the loop row and replace all of its iteration rows. */
  update(loop: Loop): void;
  findById(id: string): Loop | undefined;
  listForRun(runId: RunId): Loop[];
}

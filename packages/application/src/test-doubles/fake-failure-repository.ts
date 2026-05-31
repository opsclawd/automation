import type { Failure } from '@ai-sdlc/domain';
import type { FailureRepositoryPort } from '../ports.js';

export class FakeFailureRepository implements FailureRepositoryPort {
  inserted: Failure[] = [];

  insert(failure: Failure): void {
    this.inserted.push(failure);
  }

  findLatestByRun(runUuid: string): Failure | undefined {
    return [...this.inserted].reverse().find((f) => f.runUuid === runUuid);
  }
}

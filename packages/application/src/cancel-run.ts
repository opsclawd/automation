import { cancelRun } from '@ai-sdlc/domain';
import type { RunRepositoryPort } from './ports.js';

export interface CancelRunInput {
  issueNumber?: number;
  uuid?: string;
  reason?: string;
}

export interface CancelRunDeps {
  runRepository: RunRepositoryPort;
  now?: () => Date;
}

export class CancelRun {
  constructor(private readonly deps: CancelRunDeps) {}

  execute(input: CancelRunInput): void {
    const now = this.deps.now ?? (() => new Date());
    const existing = input.uuid
      ? this.deps.runRepository.findByUuid(input.uuid)
      : this.deps.runRepository.findByIssueNumber(input.issueNumber!);
    if (!existing) {
      const identifier = input.uuid ?? `issue ${input.issueNumber}`;
      throw new Error(`No active run found for ${identifier}`);
    }
    const cancelled = cancelRun(existing, input.reason, now());
    const updated = this.deps.runRepository.updateStatusByIssueNumber(existing.issueNumber, {
      status: cancelled.status,
      completedAt: cancelled.completedAt!,
      ...(cancelled.failureReason ? { failureReason: cancelled.failureReason } : {}),
    });
    if (!updated) {
      throw new Error(`Run for issue ${existing.issueNumber} is already ${existing.status}`);
    }
  }
}

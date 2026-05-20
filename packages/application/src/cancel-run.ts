import { cancelRun } from '@ai-sdlc/domain';
import type { RunRepositoryPort } from './ports.js';

export interface CancelRunInput {
  issueNumber: number;
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
    const existing = this.deps.runRepository.findByIssueNumber(input.issueNumber);
    if (!existing) {
      throw new Error(`No active run found for issue ${input.issueNumber}`);
    }
    // Use domain function to validate terminal state and derive canonical patch
    const cancelled = cancelRun(existing, input.reason, now());
    const updated = this.deps.runRepository.updateStatusByIssueNumber(input.issueNumber, {
      status: cancelled.status,
      completedAt: cancelled.completedAt!,
      ...(cancelled.failureReason ? { failureReason: cancelled.failureReason } : {}),
    });
    if (!updated) {
      throw new Error(`Run for issue ${input.issueNumber} is already ${existing.status}`);
    }
  }
}

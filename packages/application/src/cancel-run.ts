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
    if (['passed', 'failed', 'cancelled'].includes(existing.status)) {
      throw new Error(`Run for issue ${input.issueNumber} is already ${existing.status}`);
    }
    const completedAt = now();
    this.deps.runRepository.update(existing.uuid, {
      status: 'cancelled',
      completedAt,
      ...(input.reason ? { failureReason: input.reason } : {}),
    });
  }
}

import type { RunStatus } from './run.js';
import type { JobStatus } from './job.js';

export type ExecutionOutcome =
  | 'completed'
  | 'deferred'
  | 'operator_blocked'
  | 'failed'
  | 'cancelled';

export type SettledJobStatus = Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>;

/**
 * Maps the post-execution Run status to an internal worker ExecutionOutcome.
 */
export function runStatusToExecutionOutcome(status: RunStatus): ExecutionOutcome {
  switch (status) {
    case 'passed':
      return 'completed';
    case 'waiting':
      return 'deferred';
    case 'blocked':
    case 'needs_human_review':
      return 'operator_blocked';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'failed';
  }
}

/**
 * Maps an ExecutionOutcome to the terminal Job status.
 */
export function executionOutcomeToJobStatus(outcome: ExecutionOutcome): SettledJobStatus {
  switch (outcome) {
    case 'completed':
    case 'deferred':
    case 'operator_blocked':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

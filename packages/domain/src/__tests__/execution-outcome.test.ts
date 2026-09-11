import { describe, it, expect } from 'vitest';
import { runStatusToExecutionOutcome, executionOutcomeToJobStatus } from '../execution-outcome.js';
import type { RunStatus } from '../run.js';

describe('runStatusToExecutionOutcome', () => {
  it('maps passed to completed', () => {
    expect(runStatusToExecutionOutcome('passed')).toBe('completed');
  });

  it('maps waiting to deferred', () => {
    expect(runStatusToExecutionOutcome('waiting')).toBe('deferred');
  });

  it('maps blocked to operator_blocked', () => {
    expect(runStatusToExecutionOutcome('blocked')).toBe('operator_blocked');
  });

  it('maps needs_human_review to operator_blocked', () => {
    expect(runStatusToExecutionOutcome('needs_human_review')).toBe('operator_blocked');
  });

  it('maps failed to failed', () => {
    expect(runStatusToExecutionOutcome('failed')).toBe('failed');
  });

  it('maps cancelled to cancelled', () => {
    expect(runStatusToExecutionOutcome('cancelled')).toBe('cancelled');
  });

  it('falls back to failed for unhandled / non-terminal statuses', () => {
    expect(runStatusToExecutionOutcome('running' as RunStatus)).toBe('failed');
    expect(runStatusToExecutionOutcome('queued' as RunStatus)).toBe('failed');
  });
});

describe('executionOutcomeToJobStatus', () => {
  it('maps completed to succeeded', () => {
    expect(executionOutcomeToJobStatus('completed')).toBe('succeeded');
  });

  it('maps deferred to succeeded', () => {
    expect(executionOutcomeToJobStatus('deferred')).toBe('succeeded');
  });

  it('maps operator_blocked to succeeded', () => {
    expect(executionOutcomeToJobStatus('operator_blocked')).toBe('succeeded');
  });

  it('maps failed to failed', () => {
    expect(executionOutcomeToJobStatus('failed')).toBe('failed');
  });

  it('maps cancelled to cancelled', () => {
    expect(executionOutcomeToJobStatus('cancelled')).toBe('cancelled');
  });
});

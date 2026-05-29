import { describe, it, expect } from 'vitest';
import { RunId, PhaseName } from '../ids.js';
import {
  validationRunPassed,
  type ValidationRun,
  type ValidationCommandRecord,
} from '../validation.js';

function cmd(overrides: Partial<ValidationCommandRecord> = {}): ValidationCommandRecord {
  return {
    command: 'pnpm build',
    exitCode: 0,
    durationMs: 10,
    stdoutPath: 'validate/0-build.stdout.log',
    stderrPath: 'validate/0-build.stderr.log',
    outcome: 'passed',
    ...overrides,
  };
}

function run(commands: ValidationCommandRecord[]): ValidationRun {
  return {
    id: 'v-1',
    runId: RunId('11111111-1111-1111-1111-111111111111'),
    phaseId: PhaseName('validate'),
    commands,
    startedAt: new Date('2026-05-28T00:00:00Z'),
  };
}

describe('validationRunPassed', () => {
  it('is false for an empty command list', () => {
    expect(validationRunPassed(run([]))).toBe(false);
  });

  it('is true only when every command passed', () => {
    expect(validationRunPassed(run([cmd(), cmd({ command: 'pnpm test' })]))).toBe(true);
  });

  it('is false when any command failed', () => {
    expect(validationRunPassed(run([cmd(), cmd({ outcome: 'failed', exitCode: 1 })]))).toBe(false);
  });

  it('is false when any command timed out', () => {
    expect(validationRunPassed(run([cmd({ outcome: 'timed_out' })]))).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import {
  RunId,
  PhaseName,
  type ValidationRun,
  type ValidationCommandRecord,
} from '@ai-sdlc/domain';
import { validationRunToFailure } from '../validation-run-to-failure.js';

const RUN = '55555555-5555-5555-5555-555555555555';
const AT = new Date('2026-05-28T09:00:00Z');

function cmd(o: Partial<ValidationCommandRecord> = {}): ValidationCommandRecord {
  return {
    command: 'pnpm build',
    exitCode: 0,
    durationMs: 10,
    stdoutPath: 'validate/0-build.stdout.log',
    stderrPath: 'validate/0-build.stderr.log',
    outcome: 'passed',
    kind: 'build',
    ...o,
  };
}

function run(commands: ValidationCommandRecord[]): ValidationRun {
  return { id: 'v', runId: RunId(RUN), phaseId: PhaseName('validate'), startedAt: AT, commands };
}

describe('validationRunToFailure', () => {
  it('returns null when the run passed', () => {
    expect(validationRunToFailure(run([cmd()]), AT)).toBeNull();
  });

  it('returns validation_failed naming the failing command kinds', () => {
    const f = validationRunToFailure(
      run([
        cmd(),
        cmd({
          command: 'pnpm typecheck',
          kind: 'typecheck',
          outcome: 'failed',
          exitCode: 2,
          classifier: '12 errors',
          stdoutPath: 'validate/1-typecheck.stdout.log',
          stderrPath: 'validate/1-typecheck.stderr.log',
        }),
      ]),
      AT,
    );
    expect(f).not.toBeNull();
    expect(f!.kind).toBe('validation_failed');
    expect(f!.phase).toBe('validate');
    expect(f!.message).toMatch(/typecheck/);
    expect(f!.canRetry).toBe(true);
    expect(f!.artifacts).toContain('validate/1-typecheck.stderr.log');
    expect(f!.runUuid).toBe(RUN);
    expect(f!.detectedAt).toBe(AT);
  });

  it('returns timeout when the only failures are timeouts', () => {
    const f = validationRunToFailure(
      run([
        cmd({
          command: 'pnpm test',
          kind: 'test',
          outcome: 'timed_out',
          classifier: 'timed out after 1000ms',
        }),
      ]),
      AT,
    );
    expect(f).not.toBeNull();
    expect(f!.kind).toBe('timeout');
  });

  it('prefers validation_failed when both failures and timeouts exist', () => {
    const f = validationRunToFailure(
      run([
        cmd({
          command: 'pnpm typecheck',
          kind: 'typecheck',
          outcome: 'failed',
          exitCode: 1,
          classifier: '1 error',
        }),
        cmd({ command: 'pnpm test', kind: 'test', outcome: 'timed_out', classifier: 'timed out' }),
      ]),
      AT,
    );
    expect(f!.kind).toBe('validation_failed');
    expect(f!.message).toMatch(/timed out|timeout/i);
  });

  it('includes suggestedAction text', () => {
    const f = validationRunToFailure(
      run([cmd({ command: 'pnpm build', kind: 'build', outcome: 'failed', exitCode: 1 })]),
      AT,
    );
    expect(f!.suggestedAction).toContain('validate phase logs');
  });

  it('includes stdout and stderr paths from all failing commands in artifacts', () => {
    const f = validationRunToFailure(
      run([
        cmd({
          command: 'pnpm build',
          kind: 'build',
          outcome: 'failed',
          exitCode: 1,
          stdoutPath: 'a.stdout',
          stderrPath: 'a.stderr',
        }),
        cmd({
          command: 'pnpm test',
          kind: 'test',
          outcome: 'failed',
          exitCode: 1,
          stdoutPath: 'b.stdout',
          stderrPath: 'b.stderr',
        }),
      ]),
      AT,
    );
    expect(f!.artifacts).toEqual([
      'a.stdout',
      'a.stderr',
      'b.stdout',
      'b.stderr',
      'validation-result.json',
    ]);
  });

  it('includes validation-result.json in artifacts', () => {
    const f = validationRunToFailure(
      run([
        cmd({
          command: 'pnpm build',
          kind: 'build',
          outcome: 'failed',
          exitCode: 1,
          stdoutPath: 'validate/0-build.stdout.log',
          stderrPath: 'validate/0-build.stderr.log',
        }),
      ]),
      AT,
    );
    expect(f!.artifacts).toContain('validation-result.json');
  });

  it('uses exit code in message when classifier is absent', () => {
    const f = validationRunToFailure(
      run([cmd({ command: 'pnpm build', kind: 'build', outcome: 'failed', exitCode: 137 })]),
      AT,
    );
    expect(f!.message).toContain('exit 137');
  });
});

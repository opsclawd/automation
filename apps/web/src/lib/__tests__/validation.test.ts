import { describe, it, expect } from 'vitest';
import { sortCommandsFailingFirst, type ValidationCommandDto } from '../validation';

function cmd(command: string, outcome: ValidationCommandDto['outcome']): ValidationCommandDto {
  return {
    command,
    kind: null,
    outcome,
    exitCode: 0,
    durationMs: 1,
    stdoutPath: 'validate/x.stdout.log',
    stderrPath: 'validate/x.stderr.log',
    classifier: null,
  };
}

describe('sortCommandsFailingFirst', () => {
  it('moves failed and timed_out commands to the top, preserving relative order within groups', () => {
    const input = [
      cmd('a-pass', 'passed'),
      cmd('b-fail', 'failed'),
      cmd('c-pass', 'passed'),
      cmd('d-timeout', 'timed_out'),
    ];
    const out = sortCommandsFailingFirst(input).map((c) => c.command);
    expect(out).toEqual(['b-fail', 'd-timeout', 'a-pass', 'c-pass']);
  });

  it('does not mutate the input array', () => {
    const input = [cmd('a', 'passed'), cmd('b', 'failed')];
    sortCommandsFailingFirst(input);
    expect(input.map((c) => c.command)).toEqual(['a', 'b']);
  });

  it('returns an empty array unchanged', () => {
    expect(sortCommandsFailingFirst([])).toEqual([]);
  });
});

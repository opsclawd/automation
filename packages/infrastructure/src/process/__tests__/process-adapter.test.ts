import { describe, expect, it, vi, afterEach } from 'vitest';
import { parsePsOutput, killProcess } from '../process-adapter.js';

describe('parsePsOutput', () => {
  it('parses standard ps -eo pid,ppid,cmd output, skipping the header row', () => {
    const output = [
      '  PID  PPID CMD',
      '    1     0 /sbin/init',
      '   42     1 node /path/to/vitest/dist/worker.js',
      '   43   500 node /usr/bin/vitest run',
    ].join('\n');

    const result = parsePsOutput(output);

    expect(result).toEqual([
      { pid: 1, ppid: 0, cmd: '/sbin/init' },
      { pid: 42, ppid: 1, cmd: 'node /path/to/vitest/dist/worker.js' },
      { pid: 43, ppid: 500, cmd: 'node /usr/bin/vitest run' },
    ]);
  });

  it('preserves whitespace-separated arguments within cmd', () => {
    const output = ['  PID  PPID CMD', '   77     1 node (vitest worker) --pool=forks'].join('\n');

    const result = parsePsOutput(output);

    expect(result).toEqual([{ pid: 77, ppid: 1, cmd: 'node (vitest worker) --pool=forks' }]);
  });

  it('skips blank lines', () => {
    const output = ['  PID  PPID CMD', '', '   10     1 node vitest run', ''].join('\n');

    const result = parsePsOutput(output);

    expect(result).toEqual([{ pid: 10, ppid: 1, cmd: 'node vitest run' }]);
  });

  it('returns an empty array for header-only output', () => {
    const result = parsePsOutput('  PID  PPID CMD');
    expect(result).toEqual([]);
  });
});

describe('killProcess', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('suppresses ESRCH error if process does not exist', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      throw err;
    });
    expect(() => killProcess(999999)).not.toThrow();
  });
});

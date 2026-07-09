import { describe, expect, it } from 'vitest';
import { ReapOrphanedTestWorkers } from '../reap-orphaned-test-workers.js';
import type { ProcessInfo } from '../ports.js';

describe('ReapOrphanedTestWorkers', () => {
  it('kills a ppid=1 vitest fork-pool worker but leaves a normal process alone', () => {
    const processes: ProcessInfo[] = [
      { pid: 42, ppid: 1, cmd: 'node /path/to/vitest/dist/worker.js' },
      { pid: 43, ppid: 500, cmd: 'node /usr/bin/vitest run' },
    ];
    const killed: number[] = [];
    const usecase = new ReapOrphanedTestWorkers({
      listProcesses: () => processes,
      killProcess: (pid) => killed.push(pid),
    });

    const result = usecase.execute();

    expect(result.reaped).toBe(1);
    expect(result.pids).toEqual([42]);
    expect(killed).toEqual([42]);
  });

  it('matches the "node (vitest ...)" cmd form used by fork-pool workers', () => {
    const processes: ProcessInfo[] = [{ pid: 77, ppid: 1, cmd: 'node (vitest worker)' }];
    const killed: number[] = [];
    const usecase = new ReapOrphanedTestWorkers({
      listProcesses: () => processes,
      killProcess: (pid) => killed.push(pid),
    });

    const result = usecase.execute();

    expect(result.reaped).toBe(1);
    expect(killed).toEqual([77]);
  });

  it('does not kill a ppid=1 process whose cmd does not mention vitest', () => {
    const processes: ProcessInfo[] = [{ pid: 10, ppid: 1, cmd: '/usr/sbin/some-daemon' }];
    const killed: number[] = [];
    const usecase = new ReapOrphanedTestWorkers({
      listProcesses: () => processes,
      killProcess: (pid) => killed.push(pid),
    });

    const result = usecase.execute();

    expect(result.reaped).toBe(0);
    expect(killed).toEqual([]);
  });

  it('does not kill a vitest process that still has a live parent', () => {
    const processes: ProcessInfo[] = [{ pid: 55, ppid: 900, cmd: 'node vitest run' }];
    const killed: number[] = [];
    const usecase = new ReapOrphanedTestWorkers({
      listProcesses: () => processes,
      killProcess: (pid) => killed.push(pid),
    });

    const result = usecase.execute();

    expect(result.reaped).toBe(0);
    expect(killed).toEqual([]);
  });

  it('reaps multiple orphans in one pass', () => {
    const processes: ProcessInfo[] = [
      { pid: 1, ppid: 1, cmd: 'node vitest run' },
      { pid: 2, ppid: 1, cmd: 'node vitest run' },
      { pid: 3, ppid: 700, cmd: 'node vitest run' },
    ];
    const killed: number[] = [];
    const usecase = new ReapOrphanedTestWorkers({
      listProcesses: () => processes,
      killProcess: (pid) => killed.push(pid),
    });

    const result = usecase.execute();

    expect(result.reaped).toBe(2);
    expect(result.pids).toEqual([1, 2]);
    expect(killed).toEqual([1, 2]);
  });

  it('handles an empty process list', () => {
    const usecase = new ReapOrphanedTestWorkers({
      listProcesses: () => [],
      killProcess: () => {
        throw new Error('should not be called');
      },
    });

    const result = usecase.execute();

    expect(result).toEqual({ reaped: 0, pids: [] });
  });

  it('supports overriding the orphan-matching heuristic', () => {
    const processes: ProcessInfo[] = [{ pid: 9, ppid: 1, cmd: 'anything' }];
    const killed: number[] = [];
    const usecase = new ReapOrphanedTestWorkers({
      listProcesses: () => processes,
      killProcess: (pid) => killed.push(pid),
      isOrphanTestWorker: (proc) => proc.pid === 9,
    });

    const result = usecase.execute();

    expect(result.reaped).toBe(1);
    expect(killed).toEqual([9]);
  });

  it('continues reaping other orphans if one killProcess call throws an error', () => {
    const processes: ProcessInfo[] = [
      { pid: 1, ppid: 1, cmd: 'node vitest run' },
      { pid: 2, ppid: 1, cmd: 'node vitest run' },
    ];
    const killed: number[] = [];
    const usecase = new ReapOrphanedTestWorkers({
      listProcesses: () => processes,
      killProcess: (pid) => {
        if (pid === 1) {
          throw new Error('ESRCH: no such process');
        }
        killed.push(pid);
      },
    });

    const result = usecase.execute();

    expect(result.reaped).toBe(1);
    expect(result.pids).toEqual([2]);
    expect(killed).toEqual([2]);
  });
});

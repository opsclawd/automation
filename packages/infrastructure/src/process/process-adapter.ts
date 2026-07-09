import { execFileSync } from 'node:child_process';
import type { ProcessInfo } from '@ai-sdlc/application/ports';

export function parsePsOutput(output: string): ProcessInfo[] {
  const lines = output.split('\n').slice(1); // drop header row
  const result: ProcessInfo[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;

    const [, pidStr, ppidStr, cmd] = match;
    result.push({ pid: parseInt(pidStr!, 10), ppid: parseInt(ppidStr!, 10), cmd: cmd! });
  }

  return result;
}

export function listProcesses(): ProcessInfo[] {
  const output = execFileSync('ps', ['-eo', 'pid,ppid,cmd'], { encoding: 'utf8' });
  return parsePsOutput(output);
}

export function killProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === 'ESRCH') {
      return;
    }
    throw err;
  }
}

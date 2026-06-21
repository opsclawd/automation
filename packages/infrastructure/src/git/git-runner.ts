import { execa } from 'execa';

export class GitFailedError extends Error {
  readonly cwd: string;
  readonly command: string;
  readonly stderr: string;

  constructor(cwd: string, command: string, stderr: string) {
    super(`git failed: git ${command} (cwd: ${cwd})\n${stderr}`);
    this.name = 'GitFailedError';
    this.cwd = cwd;
    this.command = command;
    this.stderr = stderr;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export async function git(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
  try {
    const { stdout } = await execa('git', args, {
      cwd,
      timeout: timeoutMs ?? 30_000,
    });
    return stdout.trim();
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr ?? (err as Error)?.message ?? 'unknown';
    throw new GitFailedError(cwd, args.join(' '), stderr);
  }
}

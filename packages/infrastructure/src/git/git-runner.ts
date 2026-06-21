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
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Run a git command and return its trimmed stdout.
 *
 * The returned stdout is always trimmed of leading/trailing whitespace.
 * If the command fails, throws `GitFailedError` with stderr attached.
 *
 * @param cwd - Working directory for the git command.
 * @param args - Arguments passed to `git`.
 * @param timeoutMs - Timeout in milliseconds (default 30_000).
 */
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

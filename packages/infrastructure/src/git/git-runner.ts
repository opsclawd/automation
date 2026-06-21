import { execa } from 'execa';

export class GitFailedError extends Error {
  readonly cwd: string;
  readonly command: string;
  readonly stderr: string;
  readonly timedOut: boolean;

  constructor(
    cwd: string,
    command: string,
    stderr: string,
    options?: { cause?: unknown; timedOut?: boolean },
  ) {
    super(`git failed: git ${command} (cwd: ${cwd})\n${stderr}`, { cause: options?.cause });
    this.name = 'GitFailedError';
    this.cwd = cwd;
    this.command = command;
    this.stderr = stderr;
    this.timedOut = options?.timedOut ?? false;
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
    const execaErr = err as { stderr?: string; timedOut?: boolean; code?: string };
    if (execaErr.code === 'ENOENT') {
      throw new GitFailedError(cwd, args.join(' '), 'git not found on PATH', {
        cause: err,
        timedOut: false,
      });
    }
    const stderr = execaErr.stderr ?? (err as Error)?.message ?? 'unknown';
    throw new GitFailedError(cwd, args.join(' '), stderr, {
      cause: err,
      timedOut: execaErr.timedOut ?? false,
    });
  }
}

import type { GitPort } from '../ports/git-port.js';

/**
 * Checks if the git worktree at `cwd` is dirty, and if so, stages all changes
 * and commits them with the given `message`. Returns true if a commit was made.
 */
export async function commitIfDirty(deps: { git: GitPort; cwd: string; message: string }): Promise<boolean> {
  const { git, cwd, message } = deps;
  try {
    const status = await git.status(cwd);
    if (status.trim().length === 0) return false;
    await git.add(cwd, '-A');
    await git.commit(cwd, message);
    return true;
  } catch {
    return false;
  }
}

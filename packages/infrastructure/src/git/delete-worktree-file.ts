import { unlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import type { DeleteWorktreeFilePort } from '@ai-sdlc/application/ports';

/**
 * Safely deletes a file within the worktree cwd.
 * Rejects path traversal and files outside cwd.
 * Returns true if the file was deleted, false otherwise.
 */
export const deleteWorktreeFile: DeleteWorktreeFilePort = async (
  cwd: string,
  relativePath: string,
): Promise<boolean> => {
  try {
    const resolvedCwd = resolve(cwd);
    const targetPath = resolve(resolvedCwd, relativePath);
    const rel = relative(resolvedCwd, targetPath);
    if (
      rel === '' ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      rel.startsWith('../') ||
      isAbsolute(rel)
    ) {
      return false;
    }
    await unlink(targetPath);
    return true;
  } catch {
    return false;
  }
};

import type { GitPort } from './ports/git-port.js';

export type FixCommitVerification =
  | { kind: 'advanced'; headAfterFix: string; statusOutput: string }
  | {
      kind: 'uncommitted_changes';
      headAfterFix: string;
      dirtyFiles: string[];
      statusOutput: string;
    }
  | { kind: 'no_commit_claimed'; headAfterFix: string; statusOutput: string };

export type FixCommitVerificationError = { kind: 'verification_error'; error: string };

export async function verifyFixCommit(deps: {
  git: GitPort;
  cwd: string;
  expectedHead: string;
}): Promise<FixCommitVerification | FixCommitVerificationError> {
  const { git, cwd, expectedHead } = deps;
  let headAfterFix: string;
  try {
    headAfterFix = await git.headCommitSha(cwd);
  } catch (err: unknown) {
    return { kind: 'verification_error', error: err instanceof Error ? err.message : String(err) };
  }
  let statusOutput: string;
  try {
    statusOutput = await git.status(cwd);
  } catch (err: unknown) {
    return { kind: 'verification_error', error: err instanceof Error ? err.message : String(err) };
  }
  if (headAfterFix !== expectedHead) {
    return { kind: 'advanced', headAfterFix, statusOutput };
  }
  const dirtyFiles = statusOutput.split('\n').filter((l) => l.length > 0);
  if (dirtyFiles.length > 0) {
    return { kind: 'uncommitted_changes', headAfterFix, dirtyFiles, statusOutput };
  }
  return { kind: 'no_commit_claimed', headAfterFix, statusOutput };
}

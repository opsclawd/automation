export interface CreateWorktreeInput {
  repoLocalBasePath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}

export interface PushInput {
  cwd: string;
  branch: string;
  remote?: string;
}

export class TrackedSourceDriftError extends Error {
  readonly cwd: string;
  readonly driftedFiles: string[];

  constructor(cwd: string, driftedFiles: string[]) {
    super(`tracked-source drift detected in ${cwd}: ${driftedFiles.join(', ')}`);
    this.name = 'TrackedSourceDriftError';
    this.cwd = cwd;
    this.driftedFiles = driftedFiles;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export interface GitPort {
  createWorktree(input: CreateWorktreeInput): Promise<void>;
  removeWorktree(worktreePath: string): Promise<void>;
  currentBranch(cwd: string): Promise<string>;
  headCommitSha(cwd: string): Promise<string>;
  resetHard(cwd: string, commitSha: string): Promise<void>;
  diff(cwd: string, base: string, head?: string): Promise<string>;
  diffStat(cwd: string, base: string, head?: string): Promise<string>;
  add(cwd: string, files: string[]): Promise<void>;
  addAll(cwd: string): Promise<void>;
  commit(cwd: string, message: string, files?: readonly string[]): Promise<string>;
  amendCommitMessage(cwd: string, message: string): Promise<string>;
  push(input: PushInput): Promise<void>;
  remoteRef(input: { cwd: string; remote: string; ref: string }): Promise<string | undefined>;
  isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean>;
  logBetween(cwd: string, base: string, head: string): Promise<string[]>;
  cleanUntracked(cwd: string): Promise<void>;
  headCommitShaOf(cwd: string): Promise<string | undefined>;
  /**
   * Return `git status --porcelain` output for `cwd`. Empty string means the
   * working tree is clean (no staged/unstaged changes, no untracked files).
   * Used by the implement-artifact-guard to verify the no-op invariant.
   */
  status(cwd: string): Promise<string>;
  /**
   * Check for tracked-file modifications (untracked files are tolerated) and,
   * when clean, perform a hard reset to `baseBranch`.
   *
   * Throws `TrackedSourceDriftError` when tracked files have drifted.
   *
   * @param cwd - working directory of the git repository
   * @param baseBranch - any git ref (branch name, SHA, tag) to reset to when clean
   */
  resetWorktreeIfClean(cwd: string, baseBranch: string): Promise<void>;
  changedFiles(cwd: string, base: string, head?: string): Promise<string[]>;
  createdFiles(cwd: string, base: string, head?: string): Promise<string[]>;
  renamedFiles?(cwd: string, base: string, head?: string): Promise<GitRenamePair[]>;
  /**
   * Return typed file change summaries for the range `base..head` (defaulting `head` to HEAD).
   * Absence or incomplete evidence must be treated as ineligible by consumers.
   */
  fileChangeSummary?(cwd: string, base: string, head?: string): Promise<GitFileChangeSummary[]>;
  fileContent(cwd: string, ref: string, path: string): Promise<string>;
}

export type GitFileChangeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type_changed'
  | 'unknown';

export interface GitFileChangeSummary {
  path: string;
  status: GitFileChangeStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  oldPath?: string;
}

export interface GitRenamePair {
  oldPath: string;
  newPath: string;
}

export interface ArtifactGuardPort {
  seedArtifactExcludes(cwd: string): Promise<void>;
  cleanOrchestratorArtifacts(cwd: string, baseBranch?: string): Promise<void>;
}

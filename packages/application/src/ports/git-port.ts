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

export class ProtectedArtifactCollisionError extends Error {
  readonly cwd: string;
  readonly protectedPaths: string[];
  readonly startCommitSha?: string | undefined;

  constructor(cwd: string, protectedPaths: string[], startCommitSha?: string | undefined) {
    const baselineInfo = startCommitSha ? ` at baseline commit ${startCommitSha}` : '';
    super(
      `Protected pre-existing repository file(s) collided with orchestrator artifact pattern in ${cwd}${baselineInfo}: ${protectedPaths.join(', ')}`,
    );
    this.name = 'ProtectedArtifactCollisionError';
    this.cwd = cwd;
    this.protectedPaths = protectedPaths;
    this.startCommitSha = startCommitSha;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export interface GitPort {
  /**
   * Creates a git worktree at worktreePath, ensuring parent directories exist.
   */
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
  status(cwd: string, opts?: { includeIgnored?: boolean }): Promise<string>;
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
  fileContent(cwd: string, ref: string, path: string): Promise<string>;
  worktreeFileContent(cwd: string, path: string): Promise<string | undefined>;
  fetch(cwd: string, remote: string, ref?: string): Promise<void>;
  resolveRef(cwd: string, ref: string): Promise<string | undefined>;
  createBranch(cwd: string, branch: string, startPoint: string): Promise<void>;
  treeSha(cwd: string, ref: string): Promise<string | undefined>;
  mergeBranch(
    cwd: string,
    sourceRef: string,
    message: string,
  ): Promise<{ success: boolean; conflict?: boolean; error?: string }>;
  /**
   * Resolves a git ref to a full 40-character hexadecimal commit SHA.
   * Uses git rev-parse --verify "${ref}^{commit}" to peel through annotated tags
   * to their underlying commit object.
   *
   * Rejects non-commit objects (annotated tags pointing to trees or blobs, tree objects,
   * blob objects, invalid or missing refs) by returning undefined.
   * Expands abbreviated commit SHAs to the full 40-character commit SHA.
   *
   * @param cwd - Working directory of the git repository
   * @param ref - Git ref to resolve (branch, tag, HEAD, commit SHA, abbreviation)
   * @returns Full 40-hex commit SHA, or undefined if the ref cannot resolve to a commit object
   */
  resolveCommitSha(cwd: string, ref: string): Promise<string | undefined>;
  /**
   * Enumerate all regular files in the worktree, optionally including ignored regular files.
   * Guaranteed to observe tracked, untracked, and (when includeIgnored is true) ignored regular files.
   *
   * @param cwd - Working directory
   * @param opts - Enumeration options (includeIgnored)
   */
  listWorktreeFiles(cwd: string, opts?: { includeIgnored?: boolean }): Promise<string[]>;
  /**
   * Enumerate all regular file paths in the committed tree at the specified commit SHA.
   * Rejects non-commit SHAs.
   *
   * @param cwd - Working directory
   * @param commitSha - Full commit SHA
   */
  listFilesAtCommit(cwd: string, commitSha: string): Promise<string[]>;
}

export interface GitRenamePair {
  oldPath: string;
  newPath: string;
}

export interface ArtifactGuardPort {
  seedArtifactExcludes(cwd: string): Promise<void>;
  cleanOrchestratorArtifacts(
    cwd: string,
    baseBranch?: string,
    startCommitSha?: string,
  ): Promise<void>;
}

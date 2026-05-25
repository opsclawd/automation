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

export interface GitPort {
  createWorktree(input: CreateWorktreeInput): Promise<void>;
  removeWorktree(worktreePath: string): Promise<void>;
  currentBranch(cwd: string): Promise<string>;
  headCommitSha(cwd: string): Promise<string>;
  resetHard(cwd: string, commitSha: string): Promise<void>;
  diff(cwd: string, base: string, head?: string): Promise<string>;
  commit(cwd: string, message: string): Promise<string>;
  push(input: PushInput): Promise<void>;
  remoteRef(input: { cwd: string; remote: string; ref: string }): Promise<string | undefined>;
}

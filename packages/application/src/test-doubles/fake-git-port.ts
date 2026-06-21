import type { GitPort, CreateWorktreeInput, PushInput } from '../ports/git-port.js';

export class FakeGitPort implements GitPort {
  currentBranchByCwd = new Map<string, string>();
  headByCwd = new Map<string, string>();
  worktrees: string[] = [];
  commits: Array<{ cwd: string; message: string; sha: string }> = [];
  pushes: PushInput[] = [];
  remoteRefs = new Map<string, string>();
  ancestorResults = new Map<string, boolean>();
  logBetweenResults = new Map<string, string[]>();
  cleanUntrackedCalls: string[] = [];
  headCommitShaOfResults = new Map<string, string | undefined>();
  verifyCleanCalls: Array<{ cwd: string; baseBranch: string }> = [];
  verifyCleanShouldThrow = new Set<string>();

  async createWorktree(input: CreateWorktreeInput): Promise<void> {
    this.worktrees.push(input.worktreePath);
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    const idx = this.worktrees.indexOf(worktreePath);
    if (idx === -1) throw new Error(`no worktree ${worktreePath}`);
    this.worktrees.splice(idx, 1);
  }

  async currentBranch(cwd: string): Promise<string> {
    const branch = this.currentBranchByCwd.get(cwd);
    if (!branch) throw new Error(`no branch for cwd ${cwd}`);
    return branch;
  }

  async headCommitSha(cwd: string): Promise<string> {
    const sha = this.headByCwd.get(cwd);
    if (!sha) throw new Error(`no head for cwd ${cwd}`);
    return sha;
  }

  async resetHard(cwd: string, commitSha: string): Promise<void> {
    if (commitSha === 'HEAD') return;
    this.headByCwd.set(cwd, commitSha);
  }

  async diff(cwd: string, base: string, head?: string): Promise<string> {
    return `diff for ${cwd} ${base}..${head ?? 'HEAD'}`;
  }

  async commit(cwd: string, message: string): Promise<string> {
    const sha = `fake-sha-${this.commits.length + 1}`;
    this.commits.push({ cwd, message, sha });
    this.headByCwd.set(cwd, sha);
    return sha;
  }

  async push(input: PushInput): Promise<void> {
    this.pushes.push(input);
  }

  async remoteRef(input: {
    cwd: string;
    remote: string;
    ref: string;
  }): Promise<string | undefined> {
    const key = `${input.remote}/${input.ref}`;
    return this.remoteRefs.get(key);
  }

  async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    return this.ancestorResults.get(`${ancestor}|${descendant}`) ?? false;
  }

  async logBetween(cwd: string, base: string, head: string): Promise<string[]> {
    return this.logBetweenResults.get(`${base}|${head}`) ?? [];
  }

  async cleanUntracked(cwd: string): Promise<void> {
    this.cleanUntrackedCalls.push(cwd);
  }

  async headCommitShaOf(cwd: string): Promise<string | undefined> {
    return this.headCommitShaOfResults.get(cwd);
  }

  async verifyClean(cwd: string, baseBranch: string): Promise<void> {
    this.verifyCleanCalls.push({ cwd, baseBranch });
    if (this.verifyCleanShouldThrow.has(cwd)) {
      throw new Error(`TrackedSourceDriftError: fake tracked drift in ${cwd}`);
    }
  }
}

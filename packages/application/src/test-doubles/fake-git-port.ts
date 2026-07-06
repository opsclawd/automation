import type { GitPort, CreateWorktreeInput, PushInput } from '../ports/git-port.js';
import { TrackedSourceDriftError } from '../ports/git-port.js';

export class FakeGitPort implements GitPort {
  fullNameByCwd = new Map<string, string>();
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
  resetWorktreeIfCleanCalls: Array<{ cwd: string; baseBranch: string }> = [];
  statusByCwd = new Map<string, string>();
  statusCalls: string[] = [];
  resetWorktreeIfCleanShouldThrow = new Set<string>();

  async resolveFullName(cwd: string): Promise<string> {
    const fullName = this.fullNameByCwd.get(cwd);
    if (!fullName) throw new Error(`no full name for cwd ${cwd}`);
    return fullName;
  }

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

  async diffStat(cwd: string, base: string, head?: string): Promise<string> {
    return `1 file changed (stat for ${cwd} ${base}..${head ?? 'HEAD'})`;
  }

  async commit(cwd: string, message: string): Promise<string> {
    const sha = `fake-sha-${this.commits.length + 1}`;
    this.commits.push({ cwd, message, sha });
    this.headByCwd.set(cwd, sha);
    return sha;
  }

  async push(input: PushInput): Promise<void> {
    this.pushes.push(input);
    const remote = input.remote ?? 'origin';
    const head = await this.headCommitSha(input.cwd);
    if (head) {
      this.remoteRefs.set(`${remote}/${input.branch}`, head);
    }
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

  async status(cwd: string): Promise<string> {
    this.statusCalls.push(cwd);
    return this.statusByCwd.get(cwd) ?? '';
  }

  async resetWorktreeIfClean(cwd: string, baseBranch: string): Promise<void> {
    this.resetWorktreeIfCleanCalls.push({ cwd, baseBranch });
    if (this.resetWorktreeIfCleanShouldThrow.has(cwd)) {
      throw new TrackedSourceDriftError(cwd, [`fake tracked drift in ${cwd}`]);
    }
    if (baseBranch !== 'HEAD') {
      this.headByCwd.set(cwd, baseBranch);
    }
  }
}

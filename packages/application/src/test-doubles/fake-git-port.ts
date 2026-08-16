import type { GitPort, CreateWorktreeInput, PushInput } from '../ports/git-port.js';
import { TrackedSourceDriftError } from '../ports/git-port.js';

export class FakeGitPort implements GitPort {
  currentBranchByCwd = new Map<string, string>();
  headByCwd = new Map<string, string>();
  worktrees: string[] = [];
  commits: Array<{
    cwd: string;
    message: string;
    sha: string;
    files?: readonly string[];
  }> = [];
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
  changedFilesResults = new Map<string, string[]>();
  changedFilesCalls: Array<{ cwd: string; base: string; head?: string }> = [];
  createdFilesResults = new Map<string, string[]>();
  createdFilesCalls: Array<{ cwd: string; base: string; head?: string }> = [];
  fileContentResults = new Map<string, string>();
  fileContentCalls: Array<{ cwd: string; ref: string; path: string }> = [];

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

  diffCalls: Array<{ cwd: string; base: string; head?: string | undefined }> = [];

  async diff(cwd: string, base: string, head?: string): Promise<string> {
    this.diffCalls.push({ cwd, base, head });
    return `diff for ${cwd} ${base}..${head ?? 'HEAD'}`;
  }

  async diffStat(cwd: string, base: string, head?: string): Promise<string> {
    return `1 file changed (stat for ${cwd} ${base}..${head ?? 'HEAD'})`;
  }

  addCalls: Array<{ cwd: string; files: string[] }> = [];

  async add(cwd: string, files: string[]): Promise<void> {
    this.addCalls.push({ cwd, files: [...files] });
  }

  async addAll(_cwd: string): Promise<void> {
    // No-op for now, could track calls if needed
  }

  private shaCounter = 0;

  async commit(cwd: string, message: string, files?: readonly string[]): Promise<string> {
    const sha = `fake-sha-${++this.shaCounter}`;
    this.commits.push({
      cwd,
      message,
      sha,
      ...(files !== undefined ? { files: [...files] } : {}),
    });
    this.headByCwd.set(cwd, sha);
    return sha;
  }

  async amendCommitMessage(cwd: string, message: string): Promise<string> {
    const headSha = this.headByCwd.get(cwd);
    const headIndex = this.commits.findIndex(
      (commit) => commit.cwd === cwd && commit.sha === headSha,
    );
    const sha = `fake-sha-${++this.shaCounter}`;
    const commit = { cwd, message, sha };
    if (headIndex !== -1) {
      this.commits[headIndex] = commit;
    } else {
      this.commits.push(commit);
    }
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

  async changedFiles(cwd: string, base: string, head?: string): Promise<string[]> {
    this.changedFilesCalls.push({ cwd, base, ...(head ? { head } : {}) });
    return [...(this.changedFilesResults.get(`${base}|${head ?? 'HEAD'}`) ?? [])];
  }

  async createdFiles(cwd: string, base: string, head?: string): Promise<string[]> {
    this.createdFilesCalls.push({ cwd, base, ...(head ? { head } : {}) });
    return [...(this.createdFilesResults.get(`${base}|${head ?? 'HEAD'}`) ?? [])];
  }

  async fileContent(cwd: string, ref: string, path: string): Promise<string> {
    this.fileContentCalls.push({ cwd, ref, path });
    return (
      this.fileContentResults.get(`${ref}:${path}`) ??
      this.fileContentResults.get(`${ref}|${path}`) ??
      `fake content for ${ref}:${path}`
    );
  }
}

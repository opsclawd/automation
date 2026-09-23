import type {
  GitPort,
  CreateWorktreeInput,
  PushInput,
  GitRenamePair,
  ArtifactGuardPort,
} from '../ports/git-port.js';
import { TrackedSourceDriftError } from '../ports/git-port.js';

export class FakeGitPort implements GitPort, ArtifactGuardPort {
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
  renamedFilesResults = new Map<string, GitRenamePair[]>();
  renamedFilesCalls: Array<{ cwd: string; base: string; head?: string }> = [];
  fileContentResults = new Map<string, string>();
  fileContentThrows = new Map<string, Error>();
  fileContentCalls: Array<{ cwd: string; ref: string; path: string }> = [];
  worktreeFileContents = new Map<string, string>();
  worktreeFileContentCalls: Array<{ cwd: string; path: string }> = [];
  defaultWorktreeFileContent: ((path: string) => string | undefined) | string | undefined = (
    path: string,
  ) => `fake worktree content for ${path}`;
  fetchCalls: Array<{ cwd: string; remote: string; ref?: string }> = [];
  createBranchCalls: Array<{ cwd: string; branch: string; startPoint: string }> = [];
  resolveRefResults = new Map<string, string>();
  branchesByCwd = new Map<string, Set<string>>();
  resolveCommitShaResults = new Map<string, string | undefined>();
  worktreeFilesByCwd = new Map<string, string[]>();
  worktreeIgnoredFilesByCwd = new Map<string, string[]>();
  committedFilesByCommit = new Map<string, string[]>();

  createWorktreeCalls: CreateWorktreeInput[] = [];
  removeWorktreeCalls: string[] = [];
  removeWorktreeTolerateAbsent = false;
  mergeHeadByCwd = new Map<string, string>();
  defaultMergeHead?: string;
  autoAdvanceOnMerge = true;

  async createWorktree(input: CreateWorktreeInput): Promise<void> {
    this.createWorktreeCalls.push(input);
    this.worktrees.push(input.worktreePath);
    if (!this.currentBranchByCwd.has(input.worktreePath)) {
      this.currentBranchByCwd.set(input.worktreePath, input.branch);
    }
    if (!this.headByCwd.has(input.worktreePath)) {
      const baseHead =
        this.remoteRefs.get(`origin/${input.baseBranch}`) ??
        this.remoteRefs.get(input.baseBranch) ??
        this.headByCwd.get(input.repoLocalBasePath);
      if (baseHead) {
        this.headByCwd.set(input.worktreePath, baseHead);
      }
    }
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    this.removeWorktreeCalls.push(worktreePath);
    const idx = this.worktrees.indexOf(worktreePath);
    if (idx === -1) {
      if (this.removeWorktreeTolerateAbsent) return;
      throw new Error(`no worktree ${worktreePath}`);
    }
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
      this.resolveRefResults.set(`${remote}/${input.branch}`, head);
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

  async status(cwd: string, _opts?: { includeIgnored?: boolean }): Promise<string> {
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
    const key = `${base}|${head ?? 'HEAD'}`;
    if (this.createdFilesResults.has(key)) {
      return [...(this.createdFilesResults.get(key) ?? [])];
    }
    return [...(this.changedFilesResults.get(key) ?? [])];
  }

  async renamedFiles(cwd: string, base: string, head?: string): Promise<GitRenamePair[]> {
    this.renamedFilesCalls.push({ cwd, base, ...(head ? { head } : {}) });
    const key = `${base}|${head ?? 'HEAD'}`;
    return [...(this.renamedFilesResults.get(key) ?? [])];
  }

  async fileContent(cwd: string, ref: string, path: string): Promise<string> {
    this.fileContentCalls.push({ cwd, ref, path });
    const key1 = `${ref}:${path}`;
    const key2 = `${ref}|${path}`;
    if (this.fileContentThrows.has(key1)) {
      throw this.fileContentThrows.get(key1)!;
    }
    if (this.fileContentThrows.has(key2)) {
      throw this.fileContentThrows.get(key2)!;
    }
    return (
      this.fileContentResults.get(key1) ??
      this.fileContentResults.get(key2) ??
      `fake content for ${ref}:${path}`
    );
  }

  async worktreeFileContent(cwd: string, path: string): Promise<string | undefined> {
    this.worktreeFileContentCalls.push({ cwd, path });
    const fullKey = `${cwd}:${path}`;
    if (this.worktreeFileContents.has(fullKey)) {
      return this.worktreeFileContents.get(fullKey);
    }
    if (this.worktreeFileContents.has(path)) {
      return this.worktreeFileContents.get(path);
    }
    if (typeof this.defaultWorktreeFileContent === 'function') {
      return this.defaultWorktreeFileContent(path);
    }
    return this.defaultWorktreeFileContent;
  }

  async fetch(cwd: string, remote: string, ref?: string): Promise<void> {
    this.fetchCalls.push({ cwd, remote, ...(ref !== undefined ? { ref } : {}) });
  }

  async resolveRef(cwd: string, ref: string): Promise<string | undefined> {
    const key = `${cwd}:${ref}`;
    if (this.resolveRefResults.has(key)) {
      return this.resolveRefResults.get(key);
    }
    if (this.resolveRefResults.has(ref)) {
      return this.resolveRefResults.get(ref);
    }
    if (ref.startsWith('origin/')) {
      const branch = ref.slice('origin/'.length);
      const remoteKey = `origin/${branch}`;
      if (this.remoteRefs.has(remoteKey)) {
        return this.remoteRefs.get(remoteKey);
      }
    }
    return undefined;
  }

  async createBranch(cwd: string, branch: string, startPoint: string): Promise<void> {
    this.createBranchCalls.push({ cwd, branch, startPoint });
    let branches = this.branchesByCwd.get(cwd);
    if (!branches) {
      branches = new Set<string>();
      this.branchesByCwd.set(cwd, branches);
    }
    branches.add(branch);
    this.headByCwd.set(cwd, startPoint);
  }

  treeShaResults = new Map<string, string>();
  mergeBranchCalls: Array<{ cwd: string; sourceRef: string; message: string }> = [];
  mergeBranchResults = new Map<string, { success: boolean; conflict?: boolean; error?: string }>();

  async treeSha(cwd: string, ref: string): Promise<string | undefined> {
    const key = `${cwd}:${ref}`;
    if (this.treeShaResults.has(key)) return this.treeShaResults.get(key);
    if (this.treeShaResults.has(ref)) return this.treeShaResults.get(ref);
    return `tree-${ref}`;
  }

  async mergeBranch(
    cwd: string,
    sourceRef: string,
    message: string,
  ): Promise<{ success: boolean; conflict?: boolean; error?: string }> {
    this.mergeBranchCalls.push({ cwd, sourceRef, message });
    const key = `${cwd}:${sourceRef}`;
    const result = this.mergeBranchResults.has(key)
      ? this.mergeBranchResults.get(key)!
      : this.mergeBranchResults.has(sourceRef)
        ? this.mergeBranchResults.get(sourceRef)!
        : { success: true };

    if (result.success) {
      let newHead: string | undefined;
      if (this.mergeHeadByCwd.has(cwd)) {
        newHead = this.mergeHeadByCwd.get(cwd)!;
      } else if (this.defaultMergeHead) {
        newHead = this.defaultMergeHead;
      } else if (this.autoAdvanceOnMerge) {
        const currentHead = this.headByCwd.get(cwd) ?? 'head';
        newHead = `${currentHead}-merged-${++this.shaCounter}`;
      }

      if (newHead) {
        this.headByCwd.set(cwd, newHead);
        const sourceSha = this.remoteRefs.get(sourceRef) ?? (await this.resolveRef(cwd, sourceRef));
        if (sourceSha && !this.ancestorResults.has(`${sourceSha}|${newHead}`)) {
          this.ancestorResults.set(`${sourceSha}|${newHead}`, true);
        }
      }
    }

    return result;
  }

  async resolveCommitSha(cwd: string, ref: string): Promise<string | undefined> {
    const key = `${cwd}:${ref}`;
    if (this.resolveCommitShaResults.has(key)) {
      return this.resolveCommitShaResults.get(key);
    }
    if (this.resolveCommitShaResults.has(ref)) {
      return this.resolveCommitShaResults.get(ref);
    }
    if (ref === 'HEAD') {
      const head = this.headByCwd.get(cwd);
      if (head) {
        return this.resolveCommitSha(cwd, head) ?? head;
      }
    }
    const currentHead = this.headByCwd.get(cwd);
    if (currentHead && currentHead === ref) {
      return currentHead;
    }
    const foundCommit = this.commits.find((c) => c.sha === ref || (c.cwd === cwd && c.sha === ref));
    if (foundCommit) {
      return foundCommit.sha;
    }
    if (/^[0-9a-f]{40}$/i.test(ref)) {
      return ref;
    }
    return undefined;
  }

  async listWorktreeFiles(cwd: string, opts?: { includeIgnored?: boolean }): Promise<string[]> {
    const normalFiles = this.worktreeFilesByCwd.get(cwd) ?? [];
    const ignoredFiles = opts?.includeIgnored
      ? (this.worktreeIgnoredFilesByCwd.get(cwd) ?? [])
      : [];
    const fromContents: string[] = [];
    for (const key of this.worktreeFileContents.keys()) {
      if (key.startsWith(`${cwd}:`)) {
        fromContents.push(key.slice(`${cwd}:`.length));
      } else if (!key.includes(':')) {
        fromContents.push(key);
      }
    }
    return Array.from(new Set([...normalFiles, ...ignoredFiles, ...fromContents])).sort();
  }

  async listFilesAtCommit(cwd: string, commitSha: string): Promise<string[]> {
    const verifiedSha = await this.resolveCommitSha(cwd, commitSha);
    if (!verifiedSha) {
      throw new Error(`Cannot list files: '${commitSha}' does not resolve to a commit object`);
    }
    const key = `${cwd}:${verifiedSha}`;
    if (this.committedFilesByCommit.has(key)) {
      return [...(this.committedFilesByCommit.get(key) ?? [])].sort();
    }
    if (this.committedFilesByCommit.has(verifiedSha)) {
      return [...(this.committedFilesByCommit.get(verifiedSha) ?? [])].sort();
    }
    const fromFileContents: string[] = [];
    for (const k of this.fileContentResults.keys()) {
      if (k.startsWith(`${verifiedSha}:`)) {
        fromFileContents.push(k.slice(`${verifiedSha}:`.length));
      } else if (k.startsWith(`${verifiedSha}|`)) {
        fromFileContents.push(k.slice(`${verifiedSha}|`.length));
      }
    }
    return Array.from(new Set(fromFileContents)).sort();
  }

  cleanOrchestratorArtifactsCalls: Array<{
    cwd: string;
    baseBranch?: string | undefined;
    startCommitSha?: string | undefined;
  }> = [];
  cleanOrchestratorArtifactsThrows?: Error;

  async cleanOrchestratorArtifacts(
    cwd: string,
    baseBranch?: string | undefined,
    startCommitSha?: string | undefined,
  ): Promise<void> {
    this.cleanOrchestratorArtifactsCalls.push({ cwd, baseBranch, startCommitSha });
    if (this.cleanOrchestratorArtifactsThrows) {
      throw this.cleanOrchestratorArtifactsThrows;
    }
  }

  async seedArtifactExcludes(_cwd: string): Promise<void> {}
}

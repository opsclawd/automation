import { access, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import type {
  CreateWorktreeInput,
  GitPort,
  PushInput,
  ArtifactGuardPort,
  GitRenamePair,
} from '@ai-sdlc/application/ports';
import { TrackedSourceDriftError } from '@ai-sdlc/application/ports';
import { git, GitFailedError } from './git-runner.js';

export class GitWorktreeAdapter implements GitPort, ArtifactGuardPort {
  private readonly excludePatterns: readonly string[];
  private readonly patternMatchers: readonly ((file: string, basename: string) => boolean)[];

  constructor(excludePatterns: readonly string[] = []) {
    this.excludePatterns = Object.freeze([...excludePatterns]);
    this.patternMatchers = Object.freeze(
      this.excludePatterns.map((pattern) => {
        if (pattern.includes('*')) {
          const regexStr =
            '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$';
          const regex = new RegExp(regexStr);
          return (file: string, basename: string): boolean =>
            regex.test(file) || regex.test(basename);
        }
        return (file: string, basename: string): boolean =>
          file === pattern || basename === pattern;
      }),
    );
  }
  async createWorktree(input: CreateWorktreeInput): Promise<void> {
    const { repoLocalBasePath, worktreePath, branch, baseBranch } = input;

    try {
      await access(worktreePath);
      // Path exists — verify it's a valid independent worktree, not a stale directory
      const topLevel = await git(worktreePath, ['rev-parse', '--show-toplevel']);
      if (topLevel === worktreePath) return;
      // Resolved to a parent directory — treat as stale
      await rm(worktreePath, { recursive: true, force: true });
    } catch {
      await rm(worktreePath, { recursive: true, force: true });
    }

    let branchExists = false;
    try {
      await git(repoLocalBasePath, ['rev-parse', '--verify', branch]);
      branchExists = true;
    } catch {
      // branch does not exist yet
    }

    if (branchExists) {
      await git(repoLocalBasePath, ['worktree', 'add', worktreePath, branch]);
    } else {
      await git(repoLocalBasePath, ['worktree', 'add', '-b', branch, worktreePath, baseBranch]);
    }
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    let baseRepoPath: string;
    try {
      const gitCommonDir = await git(worktreePath, ['rev-parse', '--git-common-dir']);
      baseRepoPath = dirname(gitCommonDir);
    } catch {
      await rm(worktreePath, { recursive: true, force: true });
      return;
    }

    try {
      await git(baseRepoPath, ['worktree', 'remove', '--force', worktreePath]);
    } catch {
      await rm(worktreePath, { recursive: true, force: true });
      await git(baseRepoPath, ['worktree', 'prune']);
    }
  }

  async currentBranch(cwd: string): Promise<string> {
    return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  async headCommitSha(cwd: string): Promise<string> {
    return git(cwd, ['rev-parse', 'HEAD']);
  }

  async headCommitShaOf(cwd: string): Promise<string | undefined> {
    try {
      return await git(cwd, ['rev-parse', 'HEAD']);
    } catch {
      return undefined;
    }
  }

  async resetHard(cwd: string, commitSha: string): Promise<void> {
    await git(cwd, ['reset', '--hard', commitSha]);
  }

  async diff(cwd: string, base: string, head?: string): Promise<string> {
    return head ? git(cwd, ['diff', base, head]) : git(cwd, ['diff', base]);
  }

  async diffStat(cwd: string, base: string, head?: string): Promise<string> {
    return head
      ? git(cwd, ['diff', '--stat', `${base}..${head}`])
      : git(cwd, ['diff', '--stat', base]);
  }

  async add(cwd: string, files: string[]): Promise<void> {
    await git(cwd, ['add', '--', ...files]);
  }

  async addAll(cwd: string): Promise<void> {
    await git(cwd, ['add', '-A']);
  }

  async commit(cwd: string, message: string, files?: readonly string[]): Promise<string> {
    const args = ['commit', '-F', '-'];
    if (files && files.length > 0) {
      args.push('--', ...files);
    }
    try {
      await git(cwd, args, undefined, message);
    } catch (err) {
      if (err instanceof GitFailedError) {
        const causeObj = err.cause as { stdout?: string; stderr?: string } | undefined;
        const combined =
          `${err.stderr} ${err.message} ${causeObj?.stdout ?? ''} ${causeObj?.stderr ?? ''}`.toLowerCase();
        if (combined.includes('nothing to commit') || combined.includes('working tree clean')) {
          return git(cwd, ['rev-parse', 'HEAD']);
        }

        try {
          await git(cwd, ['diff', '--cached', '--quiet']);
          return git(cwd, ['rev-parse', 'HEAD']);
        } catch {
          // diff is non-empty or diff failed; rethrow original commit error
        }
      }
      throw err;
    }
    return git(cwd, ['rev-parse', 'HEAD']);
  }

  async amendCommitMessage(cwd: string, message: string): Promise<string> {
    await git(cwd, ['commit', '--amend', '-F', '-'], undefined, message);
    return git(cwd, ['rev-parse', 'HEAD']);
  }

  async push(input: PushInput): Promise<void> {
    const { cwd, branch, remote = 'origin' } = input;
    // 300s: pre-push hooks that run a full build can take ~2 minutes
    await git(cwd, ['push', remote, branch], 300_000);
  }

  async remoteRef(input: {
    cwd: string;
    remote: string;
    ref: string;
  }): Promise<string | undefined> {
    try {
      const out = await git(input.cwd, ['ls-remote', '--exit-code', input.remote, input.ref]);
      const lines = out.split('\n').filter(Boolean);
      if (lines.length === 0) return undefined;

      if (input.ref.startsWith('refs/')) {
        const exact = lines.find((l) => l.endsWith(`\t${input.ref}`));
        return exact?.split('\t')[0] ?? undefined;
      }

      const branchLine = lines.find((l) => l.endsWith(`\trefs/heads/${input.ref}`));
      return (branchLine ?? lines[0]!).split('\t')[0];
    } catch {
      return undefined;
    }
  }

  async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch (err) {
      if (err instanceof GitFailedError && err.stderr.trim() === '') {
        return false;
      }
      throw err;
    }
  }

  async logBetween(cwd: string, base: string, head: string): Promise<string[]> {
    const out = await git(cwd, ['log', '--format=%s', `${base}..${head}`]);
    return out ? out.split('\n').filter(Boolean) : [];
  }

  async cleanUntracked(cwd: string): Promise<void> {
    await git(cwd, ['clean', '-fdx', '-e', 'node_modules']);
  }

  async status(cwd: string): Promise<string> {
    return git(cwd, ['status', '--porcelain', '-uall']);
  }

  async resetWorktreeIfClean(cwd: string, baseBranch: string): Promise<void> {
    const status = await git(cwd, ['status', '--porcelain']);
    const driftedFiles = status
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.startsWith('??') && !line.startsWith('!!'))
      .map((line) => line.slice(3).trim());

    if (driftedFiles.length > 0) {
      throw new TrackedSourceDriftError(cwd, driftedFiles);
    }

    await git(cwd, ['reset', '--hard', baseBranch]);
  }

  async changedFiles(cwd: string, base: string, head = 'HEAD'): Promise<string[]> {
    const output = await git(cwd, ['diff', '-z', '--name-only', `${base}..${head}`]);
    return output
      .split('\0')
      .map((path) => path.trim().replace(/\\/g, '/'))
      .filter(Boolean)
      .sort();
  }

  async createdFiles(cwd: string, base: string, head = 'HEAD'): Promise<string[]> {
    const output = await git(cwd, [
      'diff',
      '--diff-filter=A',
      '--name-only',
      '-z',
      `${base}..${head}`,
    ]);
    const paths = output
      .split('\0')
      .map((path) => path.trim().replace(/\\/g, '/'))
      .filter(Boolean);
    return Array.from(new Set(paths)).sort();
  }

  async renamedFiles(cwd: string, base: string, head = 'HEAD'): Promise<GitRenamePair[]> {
    const output = await git(cwd, ['diff', '-z', '-M', '--name-status', `${base}..${head}`]);
    const parts = output.split('\0').filter(Boolean);
    const renames: GitRenamePair[] = [];
    let i = 0;
    while (i < parts.length) {
      const status = parts[i]!;
      if (status.startsWith('R') || status.startsWith('C')) {
        const oldPath = parts[i + 1]?.trim().replace(/\\/g, '/');
        const newPath = parts[i + 2]?.trim().replace(/\\/g, '/');
        if (oldPath && newPath) {
          renames.push({ oldPath, newPath });
        }
        i += 3;
      } else {
        i += 2;
      }
    }
    return renames;
  }

  async fileChangeSummary(
    cwd: string,
    base: string,
    head = 'HEAD',
  ): Promise<NonNullable<Awaited<ReturnType<NonNullable<GitPort['fileChangeSummary']>>>>> {
    type GitFileChangeSummary = NonNullable<
      Awaited<ReturnType<NonNullable<GitPort['fileChangeSummary']>>>
    >[number];
    type GitFileChangeStatus = GitFileChangeSummary['status'];

    const range = `${base}..${head}`;
    const [nameStatusRaw, numstatRaw] = await Promise.all([
      git(cwd, ['diff', '-z', '-M', '-C', '--name-status', range]),
      git(cwd, ['diff', '-z', '--numstat', range]),
    ]);

    interface NameStatusEntry {
      path: string;
      status: GitFileChangeStatus;
      oldPath?: string;
    }

    const nameStatusEntries: NameStatusEntry[] = [];
    const nameStatusParts = nameStatusRaw.split('\0');
    let i = 0;
    while (i < nameStatusParts.length) {
      if (i === nameStatusParts.length - 1 && nameStatusParts[i] === '') {
        break;
      }
      const rawCode = nameStatusParts[i] ?? '';
      if (!rawCode) {
        i++;
        continue;
      }
      if (rawCode.startsWith('R') || rawCode.startsWith('C')) {
        const status: GitFileChangeStatus = rawCode.startsWith('R') ? 'renamed' : 'copied';
        const oldPathRaw = nameStatusParts[i + 1];
        const newPathRaw = nameStatusParts[i + 2];
        if (oldPathRaw === undefined || newPathRaw === undefined) {
          nameStatusEntries.push({
            path: 'unknown',
            status: 'unknown',
          });
          i += 3;
          continue;
        }
        const oldPath = oldPathRaw.replace(/\\/g, '/');
        const newPath = newPathRaw.replace(/\\/g, '/');
        nameStatusEntries.push({
          path: newPath,
          oldPath,
          status,
        });
        i += 3;
      } else {
        const pathRaw = nameStatusParts[i + 1];
        if (pathRaw === undefined) {
          nameStatusEntries.push({
            path: 'unknown',
            status: 'unknown',
          });
          i += 2;
          continue;
        }
        const path = pathRaw.replace(/\\/g, '/');
        let status: GitFileChangeStatus = 'unknown';
        if (rawCode === 'M' || rawCode.startsWith('M')) {
          status = 'modified';
        } else if (rawCode === 'A' || rawCode.startsWith('A')) {
          status = 'added';
        } else if (rawCode === 'D' || rawCode.startsWith('D')) {
          status = 'deleted';
        } else if (rawCode === 'T' || rawCode.startsWith('T')) {
          status = 'type_changed';
        }
        nameStatusEntries.push({
          path,
          status,
        });
        i += 2;
      }
    }

    interface NumstatEntry {
      path: string;
      oldPath?: string;
      additions: number | null;
      deletions: number | null;
      binary: boolean;
      malformed: boolean;
    }

    const numstatEntries: NumstatEntry[] = [];
    const numstatParts = numstatRaw.split('\0');
    let j = 0;
    while (j < numstatParts.length) {
      if (j === numstatParts.length - 1 && numstatParts[j] === '') {
        break;
      }
      const token = numstatParts[j] ?? '';
      if (!token) {
        j++;
        continue;
      }
      const firstTab = token.indexOf('\t');
      const secondTab = firstTab === -1 ? -1 : token.indexOf('\t', firstTab + 1);
      if (firstTab === -1 || secondTab === -1) {
        numstatEntries.push({
          path: 'unknown',
          additions: null,
          deletions: null,
          binary: true,
          malformed: true,
        });
        j++;
        continue;
      }

      const addedStr = token.slice(0, firstTab);
      const deletedStr = token.slice(firstTab + 1, secondTab);
      const rest = token.slice(secondTab + 1);

      let additions: number | null = null;
      let deletions: number | null = null;
      let binary = false;
      let malformed = false;

      if (addedStr === '-' && deletedStr === '-') {
        binary = true;
      } else {
        const parsedAdd = Number.parseInt(addedStr, 10);
        const parsedDel = Number.parseInt(deletedStr, 10);
        if (Number.isNaN(parsedAdd) || Number.isNaN(parsedDel)) {
          malformed = true;
        } else {
          additions = parsedAdd;
          deletions = parsedDel;
        }
      }

      if (rest === '') {
        const oldPathRaw = numstatParts[j + 1];
        const newPathRaw = numstatParts[j + 2];
        if (oldPathRaw === undefined || newPathRaw === undefined) {
          numstatEntries.push({
            path: 'unknown',
            additions: null,
            deletions: null,
            binary: true,
            malformed: true,
          });
          j += 3;
          continue;
        }
        const oldPath = oldPathRaw.replace(/\\/g, '/');
        const newPath = newPathRaw.replace(/\\/g, '/');
        numstatEntries.push({
          path: newPath,
          oldPath,
          additions,
          deletions,
          binary,
          malformed,
        });
        j += 3;
      } else {
        const path = rest.replace(/\\/g, '/');
        numstatEntries.push({
          path,
          additions,
          deletions,
          binary,
          malformed,
        });
        j++;
      }
    }

    const nameStatusByPath = new Map<string, NameStatusEntry[]>();
    for (const entry of nameStatusEntries) {
      const list = nameStatusByPath.get(entry.path) ?? [];
      list.push(entry);
      nameStatusByPath.set(entry.path, list);
    }

    const numstatByPath = new Map<string, NumstatEntry[]>();
    for (const entry of numstatEntries) {
      const list = numstatByPath.get(entry.path) ?? [];
      list.push(entry);
      numstatByPath.set(entry.path, list);
    }

    const allPaths = new Set([...nameStatusByPath.keys(), ...numstatByPath.keys()]);
    const summaries: GitFileChangeSummary[] = [];

    for (const path of allPaths) {
      const nsList = nameStatusByPath.get(path);
      const numList = numstatByPath.get(path);

      if ((nsList && nsList.length > 1) || (numList && numList.length > 1)) {
        summaries.push({
          path,
          status: 'unknown',
          additions: null,
          deletions: null,
          binary: true,
        });
        continue;
      }

      const ns = nsList?.[0];
      const num = numList?.[0];

      if (!ns || !num || num.malformed) {
        summaries.push({
          path,
          status: 'unknown',
          additions: num?.additions ?? null,
          deletions: num?.deletions ?? null,
          binary: num?.binary ?? false,
          ...(ns?.oldPath ? { oldPath: ns.oldPath } : num?.oldPath ? { oldPath: num.oldPath } : {}),
        });
        continue;
      }

      summaries.push({
        path,
        status: ns.status,
        additions: num.additions,
        deletions: num.deletions,
        binary: num.binary,
        ...(ns.oldPath ? { oldPath: ns.oldPath } : num.oldPath ? { oldPath: num.oldPath } : {}),
      });
    }

    return summaries.sort((a, b) => a.path.localeCompare(b.path));
  }

  async fileContent(cwd: string, ref: string, path: string): Promise<string> {
    return git(cwd, ['show', `${ref}:${path}`], undefined, undefined, { preserveOutput: true });
  }

  async seedArtifactExcludes(cwd: string): Promise<void> {
    const gitCommonDir = await git(cwd, ['rev-parse', '--git-common-dir']);
    const excludeFile = isAbsolute(gitCommonDir)
      ? join(gitCommonDir, 'info', 'exclude')
      : resolve(cwd, gitCommonDir, 'info', 'exclude');

    const excludeDir = dirname(excludeFile);
    await mkdir(excludeDir, { recursive: true });

    let content = '';
    try {
      content = await readFile(excludeFile, 'utf8');
    } catch {
      // File does not exist
    }

    const lines = content.split('\n').map((l) => l.trim());
    const existingSet = new Set(lines);

    const patterns = this.excludePatterns;
    const toAppend: string[] = [];
    for (const pattern of patterns) {
      if (!existingSet.has(pattern)) {
        toAppend.push(pattern);
      }
    }

    if (toAppend.length > 0) {
      let newContent = content;
      if (newContent && !newContent.endsWith('\n')) {
        newContent += '\n';
      }
      newContent += toAppend.join('\n') + '\n';
      await writeFile(excludeFile, newContent, 'utf8');
    }
  }

  async cleanOrchestratorArtifacts(cwd: string, baseBranch?: string): Promise<void> {
    const parseZOutput = (output: string): string[] =>
      output
        .split('\0')
        .map((p) => p.replace(/\\/g, '/'))
        .map((p) => (p.endsWith('/') ? p.slice(0, -1) : p))
        .filter(Boolean);

    // 1. Get list of staged files
    let stagedSet = new Set<string>();
    try {
      const stagedOutput = await git(cwd, ['diff', '-z', '--cached', '--name-only']);
      stagedSet = new Set(parseZOutput(stagedOutput));
    } catch {
      // ignore
    }

    // 2. Get list of committed files on current branch relative to baseBranch
    const committedSet = new Set<string>();
    if (baseBranch) {
      try {
        const diffOutput = await git(cwd, ['diff', '-z', `${baseBranch}...HEAD`, '--name-only']);
        for (const file of parseZOutput(diffOutput)) {
          committedSet.add(file);
        }
      } catch {
        // Base branch diff failed or base branch doesn't exist yet
      }
    }

    // Get list of tracked files once
    let trackedSet = new Set<string>();
    try {
      const trackedOutput = await git(cwd, ['ls-files', '-z']);
      trackedSet = new Set(parseZOutput(trackedOutput));
    } catch {
      // ignore
    }

    // 3. Process untracked files (both unignored and ignored directories/files)
    let untrackedFiles: string[] = [];
    try {
      const [unignoredOutput, ignoredOutput] = await Promise.all([
        git(cwd, ['ls-files', '-z', '--others', '--exclude-standard']),
        git(cwd, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']),
      ]);
      untrackedFiles = [...parseZOutput(unignoredOutput), ...parseZOutput(ignoredOutput)];
    } catch {
      // ignore
    }

    const allCandidates = new Set([
      ...untrackedFiles,
      ...stagedSet,
      ...committedSet,
      ...trackedSet,
    ]);

    const resolvedArtifacts = new Set<string>();
    for (const candidate of allCandidates) {
      const cleanPath = candidate.endsWith('/') ? candidate.slice(0, -1) : candidate;
      const basename = cleanPath.includes('/')
        ? cleanPath.slice(cleanPath.lastIndexOf('/') + 1)
        : cleanPath;
      for (const matcher of this.patternMatchers) {
        if (matcher(cleanPath, basename)) {
          resolvedArtifacts.add(cleanPath);
          break;
        }
      }
    }

    const removedCommittedArtifacts: string[] = [];

    for (const artifact of resolvedArtifacts) {
      const artifactPath = join(cwd, artifact);

      // Check if tracked
      const isTracked = trackedSet.has(artifact);

      if (baseBranch && committedSet.has(artifact)) {
        try {
          await git(cwd, ['rm', '-rf', '--', artifact]);
          removedCommittedArtifacts.push(artifact);
        } catch {
          // If git rm fails, ensure filesystem cleanup
          await rm(artifactPath, { recursive: true, force: true });
        }
      } else if (stagedSet.has(artifact)) {
        try {
          await git(cwd, ['reset', 'HEAD', '--', artifact]);
        } catch {
          // ignore
        }
        await rm(artifactPath, { recursive: true, force: true });
      } else if (!isTracked) {
        await rm(artifactPath, { recursive: true, force: true });
      }
    }

    // 4. Commit the removals if any committed artifacts were removed
    if (removedCommittedArtifacts.length > 0) {
      try {
        await git(cwd, [
          '-c',
          'user.name=Agent',
          '-c',
          'user.email=agent@local',
          'commit',
          '--no-verify',
          '--only',
          '-m',
          'fix: remove orchestrator artifacts that were committed by agent',
          '--',
          ...removedCommittedArtifacts,
        ]);
      } catch (err) {
        console.warn(
          `Failed to commit orchestrator artifact removal: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

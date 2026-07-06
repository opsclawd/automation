import { access, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import type {
  CreateWorktreeInput,
  GitPort,
  PushInput,
  ArtifactGuardPort,
} from '@ai-sdlc/application/ports';
import { TrackedSourceDriftError } from '@ai-sdlc/application/ports';
import { git, GitFailedError } from './git-runner.js';

export const ORCHESTRATOR_ARTIFACT_PATHS = Object.freeze([
  'validation.headsha',
  'review-fix-plan.json',
  'review-task-manifest.json',
  'review-triage.md',
  'code-review.md',
  'review.md',
  'task-manifest.json',
  'implementation-log.md',
  'arbiter-result.json',
  'review-loop-history.json',
  'compound-draft.md',
  'validation.result',
  'result.json',
  'fix-validate-done.marker',
  'plan-review-passed.marker',
] as const);

export const ORCHESTRATOR_PATCH_EXCLUDE = '*.patch';

export function orchestratorExcludePatterns(): readonly string[] {
  return Object.freeze([...ORCHESTRATOR_ARTIFACT_PATHS, ORCHESTRATOR_PATCH_EXCLUDE]);
}

export class GitWorktreeAdapter implements GitPort, ArtifactGuardPort {
  async resolveFullName(cwd: string): Promise<string> {
    const remoteUrl = await git(cwd, ['remote', 'get-url', 'origin']);
    // Handle SSH: git@github.com:owner/repo.git
    // Handle HTTPS: https://github.com/owner/repo.git
    const match = remoteUrl.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (!match || !match[1]) throw new Error(`Could not parse repository full name from remote URL: ${remoteUrl}`);
    return match[1];
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

  async commit(cwd: string, message: string): Promise<string> {
    await git(cwd, ['commit', '-m', message]);
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
    return git(cwd, ['status', '--porcelain']);
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

    const patterns = orchestratorExcludePatterns();
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
    // 1. Get list of staged files
    const stagedOutput = await git(cwd, ['diff', '--cached', '--name-only']);
    const stagedSet = new Set(
      stagedOutput
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );

    // 2. Get list of committed files on current branch relative to baseBranch
    const committedSet = new Set<string>();
    if (baseBranch) {
      try {
        const diffOutput = await git(cwd, ['diff', `${baseBranch}...HEAD`, '--name-only']);
        for (const line of diffOutput
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)) {
          committedSet.add(line);
        }
      } catch {
        // Base branch diff failed or base branch doesn't exist yet
      }
    }

    // Get list of tracked files once
    let trackedSet = new Set<string>();
    try {
      const trackedOutput = await git(cwd, ['ls-files']);
      trackedSet = new Set(
        trackedOutput
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      );
    } catch {
      // ignore
    }

    // 3. Process each canonical artifact
    const removedCommittedArtifacts: string[] = [];

    for (const artifact of ORCHESTRATOR_ARTIFACT_PATHS) {
      const artifactPath = join(cwd, artifact);

      // Check if tracked
      const isTracked = trackedSet.has(artifact);

      if (baseBranch && committedSet.has(artifact)) {
        try {
          await git(cwd, ['rm', '-f', '--', artifact]);
          removedCommittedArtifacts.push(artifact);
        } catch {
          // If git rm fails, ensure filesystem cleanup
          await rm(artifactPath, { force: true });
        }
      } else if (stagedSet.has(artifact)) {
        try {
          await git(cwd, ['reset', 'HEAD', '--', artifact]);
        } catch {
          // ignore
        }
        await rm(artifactPath, { force: true });
      } else if (!isTracked) {
        await rm(artifactPath, { force: true });
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

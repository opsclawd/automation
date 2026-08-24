import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import type {
  WorktreeLifecyclePort,
  InspectWorktreeLifecycleInput,
  WorktreeLifecyclePlan,
  ExecuteWorktreeLifecyclePlanInput,
  WorktreeLifecycleExecutionResult,
} from '@ai-sdlc/application/ports';
import { git } from './git-runner.js';

const DEFAULT_PRESERVED_EXACT = new Set([
  '.gitignore',
  '.ai-orchestrator.json',
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
  'compound.md',
  'validation.result',
  'result.json',
  'scratch-files.json',
  '.ai-tmp/scratch-files.json',
  'fix-validate-done.marker',
  'plan-review-passed.marker',
  'pr-summary.md',
  'pr-url.txt',
  'issue.md',
  'issue-comments.md',
  'design.md',
  'plan.md',
  'prompt.md',
  'plan-fix-result.json',
  'plan-review-findings.md',
  'diff.txt',
]);

const DEFAULT_PRESERVED_PATTERNS = [
  /^implement-step-history-.*\.json$/,
  /^quality-review-result.*\.json$/,
  /^spec-review-result.*\.json$/,
  /^fix-result.*\.json$/,
  /^task-context-step-.*\.md$/,
  /^implementation-log.*\.md$/,
  /\.patch$/,
  /\.diff$/,
  /-diff\.txt$/,
  /^\.ai-tmp\/.*/,
];

function normalizePosixPath(path: string): string {
  if (!path || typeof path !== 'string') return '';
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/|\/)+/, '')
    .replace(/\/+$/, '');
}

function assertSafePath(cwd: string, rawPath: string): string {
  const norm = normalizePosixPath(rawPath);
  if (!norm) return '';
  const resolvedCwd = resolve(cwd);
  const resolvedPath = resolve(resolvedCwd, norm);
  const rel = relative(resolvedCwd, resolvedPath);
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith('../') ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(`Path '${rawPath}' traverses outside working directory '${cwd}'`);
  }
  return norm;
}

export interface WorktreeLifecycleAdapterOptions {
  isPreserved?: (path: string) => boolean;
}

const CHECKOUT_CHUNK_SIZE = 500;
const DELETE_CHUNK_SIZE = 500;

async function deleteFilesChunked(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const uniqueDelete = Array.from(new Set(paths)).sort();
  for (let i = 0; i < uniqueDelete.length; i += DELETE_CHUNK_SIZE) {
    const chunk = uniqueDelete.slice(i, i + DELETE_CHUNK_SIZE);
    await Promise.all(chunk.map((p) => rm(p, { recursive: true, force: true })));
  }
}

async function checkoutFilesChunked(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  const uniqueCheckout = Array.from(new Set(files)).sort();
  for (let i = 0; i < uniqueCheckout.length; i += CHECKOUT_CHUNK_SIZE) {
    const chunk = uniqueCheckout.slice(i, i + CHECKOUT_CHUNK_SIZE);
    await git(cwd, ['checkout', 'HEAD', '--', ...chunk]);
  }
}

function extractStatusPaths(resolvedCwd: string, statusOutput: string): string[] {
  const entries = statusOutput.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.length < 3) continue;
    const statusCode = entry.slice(0, 2);
    const rawFilePath = entry.slice(3);
    const normPath = assertSafePath(resolvedCwd, rawFilePath);
    if (normPath) {
      paths.push(normPath);
    }
    if (statusCode.includes('R') || statusCode.includes('C')) {
      i++; // skip and capture original path for renames/copies
      const rawOrigPath = entries[i];
      if (rawOrigPath) {
        const normOrig = assertSafePath(resolvedCwd, rawOrigPath);
        if (normOrig) {
          paths.push(normOrig);
        }
      }
    }
  }
  return Array.from(new Set(paths));
}

export class WorktreeLifecycleAdapter implements WorktreeLifecyclePort {
  private readonly customIsPreserved: ((path: string) => boolean) | undefined;

  constructor(options?: WorktreeLifecycleAdapterOptions) {
    this.customIsPreserved = options?.isPreserved;
  }

  private isPreservedPath(path: string): boolean {
    if (this.customIsPreserved?.(path)) {
      return true;
    }
    const norm = normalizePosixPath(path);
    if (!norm) return false;
    const basename = norm.includes('/') ? norm.slice(norm.lastIndexOf('/') + 1) : norm;
    if (DEFAULT_PRESERVED_EXACT.has(norm) || DEFAULT_PRESERVED_EXACT.has(basename)) {
      return true;
    }
    return DEFAULT_PRESERVED_PATTERNS.some((re) => re.test(norm) || re.test(basename));
  }

  async inspect(input: InspectWorktreeLifecycleInput): Promise<WorktreeLifecyclePlan> {
    const { cwd, mode, targetBaseline } = input;
    const resolvedCwd = resolve(cwd);

    if (mode === 'resume_baseline') {
      if (!targetBaseline || targetBaseline.trim() === '') {
        throw new Error('targetBaseline is required for resume_baseline mode');
      }
      try {
        await git(resolvedCwd, ['rev-parse', '--verify', `${targetBaseline.trim()}^{commit}`]);
      } catch (err) {
        throw new Error(
          `targetBaseline '${targetBaseline}' is unresolvable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const headSha = await git(resolvedCwd, ['rev-parse', 'HEAD']);
    const statusOutput = await git(resolvedCwd, ['status', '--porcelain=v1', '-uall', '-z']);

    const trackedChanges: string[] = [];
    const untrackedPaths: string[] = [];
    const discardedPaths: string[] = [];
    const preservedPaths: string[] = [];

    const entries = statusOutput.split('\0').filter(Boolean);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || entry.length < 3) continue;

      const statusCode = entry.slice(0, 2);
      const rawFilePath = entry.slice(3);
      const normPath = assertSafePath(resolvedCwd, rawFilePath);
      if (!normPath) continue;

      if (statusCode.includes('R') || statusCode.includes('C')) {
        // Next entry is the original path
        i++;
        const rawOrigPath = entries[i];
        if (rawOrigPath) {
          const normOrig = assertSafePath(resolvedCwd, rawOrigPath);
          if (normOrig) {
            trackedChanges.push(normOrig);
            if (this.isPreservedPath(normOrig)) {
              preservedPaths.push(normOrig);
            } else {
              discardedPaths.push(normOrig);
            }
          }
        }
      }

      if (statusCode === '??') {
        untrackedPaths.push(normPath);
        if (this.isPreservedPath(normPath)) {
          preservedPaths.push(normPath);
        } else {
          discardedPaths.push(normPath);
        }
      } else {
        trackedChanges.push(normPath);
        if (this.isPreservedPath(normPath)) {
          preservedPaths.push(normPath);
        } else {
          discardedPaths.push(normPath);
        }
      }
    }

    const sortedTracked = Array.from(new Set(trackedChanges)).sort();
    const sortedUntracked = Array.from(new Set(untrackedPaths)).sort();
    const sortedDiscarded = Array.from(new Set(discardedPaths)).sort();
    const sortedPreserved = Array.from(new Set(preservedPaths)).sort();

    const fingerprint = createHash('sha256').update(`${headSha}\n${statusOutput}`).digest('hex');

    return {
      mode,
      cwd: resolvedCwd,
      ...(targetBaseline !== undefined ? { targetBaseline: targetBaseline.trim() } : {}),
      fingerprint,
      discardedPaths: sortedDiscarded,
      preservedPaths: sortedPreserved,
      trackedChanges: sortedTracked,
      untrackedPaths: sortedUntracked,
    };
  }

  async execute(
    input: ExecuteWorktreeLifecyclePlanInput,
  ): Promise<WorktreeLifecycleExecutionResult> {
    const { plan } = input;
    const resolvedCwd = resolve(plan.cwd);

    // Validate path safety for all paths in plan
    for (const p of [
      ...plan.discardedPaths,
      ...plan.preservedPaths,
      ...plan.trackedChanges,
      ...plan.untrackedPaths,
    ]) {
      assertSafePath(resolvedCwd, p);
    }

    // Verify snapshot drift
    const currentHead = await git(resolvedCwd, ['rev-parse', 'HEAD']);
    const currentStatus = await git(resolvedCwd, ['status', '--porcelain=v1', '-uall', '-z']);
    const currentFingerprint = createHash('sha256')
      .update(`${currentHead}\n${currentStatus}`)
      .digest('hex');

    if (currentFingerprint !== plan.fingerprint) {
      throw new Error('Worktree snapshot drifted between inspection and execution');
    }

    const preservedSet = new Set(plan.preservedPaths);
    const discardedSet = new Set(plan.discardedPaths);

    if (plan.mode === 'phase_boundary') {
      const preMutationHead = currentHead;

      // 1. Unstage changes to HEAD if there were tracked changes
      if (plan.trackedChanges.length > 0) {
        await git(resolvedCwd, ['reset', 'HEAD']);
      }

      // 2. Query worktree status after reset to classify uncommitted files
      const statusAfterReset = await git(resolvedCwd, ['status', '--porcelain=v1', '-uall', '-z']);
      const resetEntries = statusAfterReset.split('\0').filter(Boolean);
      const filesToCheckout: string[] = [];
      const filesToDelete: string[] = [];

      for (let i = 0; i < resetEntries.length; i++) {
        const entry = resetEntries[i];
        if (!entry || entry.length < 3) continue;
        const statusCode = entry.slice(0, 2);
        const rawFilePath = entry.slice(3);
        const normPath = assertSafePath(resolvedCwd, rawFilePath);
        if (!normPath) continue;

        if (statusCode.includes('R') || statusCode.includes('C')) {
          i++; // skip orig path if porcelain reported rename
        }

        if (preservedSet.has(normPath)) {
          // If a tracked preserved file was deleted on disk or renamed away, restore it from HEAD
          if (statusCode.includes('D')) {
            filesToCheckout.push(normPath);
          }
        } else if (discardedSet.has(normPath)) {
          if (statusCode === '??') {
            filesToDelete.push(resolve(resolvedCwd, normPath));
          } else {
            filesToCheckout.push(normPath);
          }
        }
      }

      await deleteFilesChunked(filesToDelete);
      await checkoutFilesChunked(resolvedCwd, filesToCheckout);

      // 3. Postcondition verification
      const postMutationHead = await git(resolvedCwd, ['rev-parse', 'HEAD']);
      if (postMutationHead !== preMutationHead) {
        throw new Error(
          `Postcondition failed: expected HEAD to remain ${preMutationHead}, got ${postMutationHead}`,
        );
      }

      const postStatus = await git(resolvedCwd, ['status', '--porcelain=v1', '-uall', '-z']);
      const postDirtyPaths = extractStatusPaths(resolvedCwd, postStatus);
      const stillDirtyDiscarded = plan.discardedPaths.filter((p: string) =>
        postDirtyPaths.includes(p),
      );
      if (stillDirtyDiscarded.length > 0) {
        throw new Error(
          `Postcondition failed: discarded paths still present after phase_boundary cleanup: ${stillDirtyDiscarded.join(', ')}`,
        );
      }

      return {
        success: true,
        discardedPaths: plan.discardedPaths,
        preservedPaths: plan.preservedPaths,
        headSha: postMutationHead,
      };
    }

    if (plan.mode === 'resume_baseline') {
      if (!plan.targetBaseline) {
        throw new Error('targetBaseline is required for resume_baseline mode');
      }

      const targetSha = await git(resolvedCwd, ['rev-parse', `${plan.targetBaseline}^{commit}`]);

      // 1. Mixed reset to target baseline - moves HEAD and index without destroying uncommitted preserved files
      await git(resolvedCwd, ['reset', plan.targetBaseline]);

      // 2. Query status to delete untracked discarded files and checkout modified/deleted unpreserved files
      const statusAfterReset = await git(resolvedCwd, ['status', '--porcelain=v1', '-uall', '-z']);
      const resetEntries = statusAfterReset.split('\0').filter(Boolean);
      const filesToCheckout: string[] = [];
      const filesToDelete: string[] = [];

      for (let i = 0; i < resetEntries.length; i++) {
        const entry = resetEntries[i];
        if (!entry || entry.length < 3) continue;
        const statusCode = entry.slice(0, 2);
        const rawFilePath = entry.slice(3);
        const normPath = assertSafePath(resolvedCwd, rawFilePath);
        if (!normPath) continue;

        if (statusCode.includes('R') || statusCode.includes('C')) {
          i++; // skip orig path if porcelain reported rename
        }

        if (preservedSet.has(normPath)) {
          // If a tracked preserved file was deleted on disk or renamed away, restore it from HEAD
          if (statusCode.includes('D')) {
            filesToCheckout.push(normPath);
          }
        } else {
          if (statusCode === '??') {
            filesToDelete.push(resolve(resolvedCwd, normPath));
          } else {
            filesToCheckout.push(normPath);
          }
        }
      }

      await deleteFilesChunked(filesToDelete);
      await checkoutFilesChunked(resolvedCwd, filesToCheckout);

      // 3. Postcondition verification
      const postMutationHead = await git(resolvedCwd, ['rev-parse', 'HEAD']);
      if (postMutationHead !== targetSha) {
        throw new Error(
          `Postcondition failed: expected HEAD to be ${targetSha}, got ${postMutationHead}`,
        );
      }

      const postStatus = await git(resolvedCwd, ['status', '--porcelain=v1', '-uall', '-z']);
      const postDirtyPaths = extractStatusPaths(resolvedCwd, postStatus);
      const stillDirtyDiscarded = plan.discardedPaths.filter((p: string) =>
        postDirtyPaths.includes(p),
      );
      if (stillDirtyDiscarded.length > 0) {
        throw new Error(
          `Postcondition failed: discarded paths still present after resume_baseline cleanup: ${stillDirtyDiscarded.join(', ')}`,
        );
      }

      return {
        success: true,
        discardedPaths: plan.discardedPaths,
        preservedPaths: plan.preservedPaths,
        headSha: postMutationHead,
      };
    }

    throw new Error(`Unsupported mode: ${(plan as { mode: string }).mode}`);
  }
}

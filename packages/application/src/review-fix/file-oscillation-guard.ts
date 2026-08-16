import { createHash } from 'node:crypto';
import type { GitPort } from '../ports/git-port.js';
import { normalizeRepositoryPath } from './review-fix-scope.js';

export interface FileStateSnapshot {
  hash: string;
  commitSha: string;
  iteration: number;
}

export type FileStateHistory = Map<string, FileStateSnapshot[]>;

export interface FileOscillationMatch {
  path: string;
  repeatedHash: string;
  repeatedSha: string;
  repeatedIteration: number;
  repeatedContent: string;
  contestedHash: string;
  contestedSha: string;
  contestedIteration: number;
  contestedContent: string;
}

export interface FileOscillationSkipped {
  path: string;
  ref: string;
  error: string;
}

export type FileOscillationCheckResult =
  | {
      kind: 'oscillation_detected';
      match: FileOscillationMatch;
    }
  | {
      kind: 'no_oscillation';
      skipped: FileOscillationSkipped[];
    };

export interface InspectFileOscillationInput {
  git: GitPort;
  cwd: string;
  headBeforeFix: string;
  headAfterFix: string;
  iterationIndex: number;
  fixChangedFiles: readonly string[];
  history: FileStateHistory;
}

export function formatFileOscillationReason(
  match: FileOscillationMatch,
  currentIteration: number,
): string {
  return `File content oscillation detected for "${match.path}": content at iteration ${currentIteration} (${match.repeatedSha}) returned to earlier state from iteration ${match.repeatedIteration} (${match.repeatedSha}), alternating with contested state at iteration ${match.contestedIteration} (${match.contestedSha}).\n\nRepeated content:\n${match.repeatedContent}\n\nContested content:\n${match.contestedContent}`;
}

export async function inspectFixCommitForOscillation(
  input: InspectFileOscillationInput,
): Promise<FileOscillationCheckResult> {
  const { git, cwd, headBeforeFix, headAfterFix, iterationIndex, fixChangedFiles, history } = input;
  const skipped: FileOscillationSkipped[] = [];

  for (const rawPath of fixChangedFiles) {
    const normalizedPath =
      normalizeRepositoryPath(rawPath, cwd) ?? rawPath.trim().replace(/\\/g, '/');
    if (!normalizedPath) {
      continue;
    }

    let snapshots = history.get(normalizedPath);
    if (!snapshots) {
      snapshots = [];
      history.set(normalizedPath, snapshots);
    }

    // Ensure the before-ref state is recorded when readable
    if (snapshots.length === 0 || snapshots[snapshots.length - 1]?.commitSha !== headBeforeFix) {
      try {
        const beforeContent = await git.fileContent(cwd, headBeforeFix, normalizedPath);
        const beforeHash = createHash('sha256').update(beforeContent).digest('hex');
        const beforeIteration = Math.max(0, iterationIndex - 1);
        if (snapshots.length === 0 || snapshots[snapshots.length - 1]?.hash !== beforeHash) {
          snapshots.push({
            hash: beforeHash,
            commitSha: headBeforeFix,
            iteration: beforeIteration,
          });
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        skipped.push({
          path: normalizedPath,
          ref: headBeforeFix,
          error: errorMsg,
        });
      }
    }

    // Read the after-ref content
    let afterContent: string;
    try {
      afterContent = await git.fileContent(cwd, headAfterFix, normalizedPath);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      skipped.push({
        path: normalizedPath,
        ref: headAfterFix,
        error: errorMsg,
      });
      continue;
    }

    const afterHash = createHash('sha256').update(afterContent).digest('hex');

    if (snapshots.length === 0) {
      snapshots.push({
        hash: afterHash,
        commitSha: headAfterFix,
        iteration: iterationIndex,
      });
      continue;
    }

    const immediatelyPrior = snapshots[snapshots.length - 1]!;
    if (immediatelyPrior.hash === afterHash) {
      // Consecutive identical observations are not oscillation
      snapshots.push({
        hash: afterHash,
        commitSha: headAfterFix,
        iteration: iterationIndex,
      });
      continue;
    }

    // Immediately prior snapshot has a different hash. Check earlier snapshots for a match.
    const earlierSnapshots = snapshots.slice(0, -1);
    const earlierMatch = earlierSnapshots.find((s) => s.hash === afterHash);

    if (earlierMatch) {
      // Confirmed repeat. Fetch contested state content using immediatelyPrior commitSha.
      let contestedContent: string;
      try {
        contestedContent = await git.fileContent(cwd, immediatelyPrior.commitSha, normalizedPath);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        skipped.push({
          path: normalizedPath,
          ref: immediatelyPrior.commitSha,
          error: errorMsg,
        });
        continue;
      }

      return {
        kind: 'oscillation_detected',
        match: {
          path: normalizedPath,
          repeatedHash: afterHash,
          repeatedSha: earlierMatch.commitSha,
          repeatedIteration: earlierMatch.iteration,
          repeatedContent: afterContent,
          contestedHash: immediatelyPrior.hash,
          contestedSha: immediatelyPrior.commitSha,
          contestedIteration: immediatelyPrior.iteration,
          contestedContent,
        },
      };
    }

    // New content state, record snapshot
    snapshots.push({
      hash: afterHash,
      commitSha: headAfterFix,
      iteration: iterationIndex,
    });
  }

  return {
    kind: 'no_oscillation',
    skipped,
  };
}

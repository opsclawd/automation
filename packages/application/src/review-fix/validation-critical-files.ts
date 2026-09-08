import { createHash } from 'node:crypto';
import type { GitPort } from '../ports/git-port.js';
import { normalizeRepositoryPath } from './review-fix-scope.js';
import {
  parseGitStatusLine,
  unquoteGitPath,
  isOrchestratorArtifactPattern,
} from '../artifacts/orchestrator-artifacts.js';

export const DELETED_SENTINEL = '__DELETED__' as const;

export interface ValidationCriticalFile {
  path: string; // repo-relative, normalized like other scope paths
  beforeHash: string; // sha256 of pre-fix content, or DELETED_SENTINEL
  afterHash: string; // sha256 of post-fix content, or DELETED_SENTINEL
  diagnostic: string; // short excerpt of the failure this file's content fixes
  recordedAtIteration?: number; // present for in-loop (ReviewFixLoop) tracking; absent for the cross-phase artifact
}

/**
 * Computes the SHA-256 hash of the content, or returns DELETED_SENTINEL if undefined.
 */
export function hashContent(content: string | undefined): string {
  if (content === undefined) {
    return DELETED_SENTINEL;
  }
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Parses `git status --porcelain -uall` output into a set of normalized repo-relative paths.
 */
export function parseStatusPaths(statusOutput: string, cwd: string = ''): Set<string> {
  const result = new Set<string>();
  if (!statusOutput || typeof statusOutput !== 'string') {
    return result;
  }

  const lines = statusOutput.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.length < 3) {
      continue;
    }
    const statusCode = line.slice(0, 2);
    if (statusCode === '!!') {
      continue;
    }
    const rawPaths = parseGitStatusLine(line);
    if (rawPaths.length === 0) {
      continue;
    }
    const isRenameOrCopy =
      statusCode.charAt(0) === 'R' ||
      statusCode.charAt(1) === 'R' ||
      statusCode.charAt(0) === 'C' ||
      statusCode.charAt(1) === 'C';
    const targetPaths =
      isRenameOrCopy && rawPaths.length > 1 ? [rawPaths[rawPaths.length - 1]!] : rawPaths;

    for (const rawPath of targetPaths) {
      const unquoted = unquoteGitPath(rawPath);
      if (!unquoted || isOrchestratorArtifactPattern(unquoted)) {
        continue;
      }
      const normalized = normalizeRepositoryPath(unquoted, cwd);
      if (normalized) {
        result.add(normalized);
      }
    }
  }
  return result;
}

/**
 * Captures validation-critical files changed during a worktree-based (non-committing) fix pass.
 */
export async function recordValidationCriticalFilesFromWorktree(input: {
  git: GitPort;
  cwd: string;
  dirtyBefore: Map<string, string | undefined>;
  diagnostic: string;
  recordedAtIteration?: number;
}): Promise<ValidationCriticalFile[]> {
  const { git, cwd, dirtyBefore, diagnostic, recordedAtIteration } = input;
  let statusOutput = '';
  try {
    statusOutput = await git.status(cwd);
  } catch {
    return [];
  }

  const dirtyAfter = parseStatusPaths(statusOutput, cwd);
  // Any path in dirtyBefore that is absent from dirtyAfter was restored to clean HEAD by the fixer and must be dropped (DESIGN-14, F-caf88fdc).
  const candidatePaths = Array.from(dirtyAfter).sort();
  const results: ValidationCriticalFile[] = [];

  for (const path of candidatePaths) {
    if (isOrchestratorArtifactPattern(path)) {
      continue;
    }
    let afterContent: string | undefined;
    try {
      afterContent = await git.worktreeFileContent(cwd, path);
    } catch {
      afterContent = undefined;
    }
    const afterHash = hashContent(afterContent);

    let beforeHash: string;
    if (dirtyBefore.has(path)) {
      beforeHash = hashContent(dirtyBefore.get(path));
    } else {
      try {
        const headContent = await git.fileContent(cwd, 'HEAD', path);
        beforeHash = hashContent(headContent);
      } catch {
        beforeHash = DELETED_SENTINEL;
      }
    }

    if (beforeHash === afterHash) {
      continue;
    }

    results.push({
      path,
      beforeHash,
      afterHash,
      diagnostic,
      ...(recordedAtIteration !== undefined ? { recordedAtIteration } : {}),
    });
  }

  return results;
}

/**
 * Captures validation-critical files changed between two commit SHAs.
 */
export async function recordValidationCriticalFilesFromCommits(input: {
  git: GitPort;
  cwd: string;
  headBeforeFix: string;
  headAfterFix: string;
  changedFiles: string[];
  diagnostic: string;
  recordedAtIteration?: number;
}): Promise<ValidationCriticalFile[]> {
  const { git, cwd, headBeforeFix, headAfterFix, changedFiles, diagnostic, recordedAtIteration } =
    input;
  const results: ValidationCriticalFile[] = [];

  for (const rawPath of changedFiles) {
    const path = normalizeRepositoryPath(rawPath, cwd);
    if (!path || isOrchestratorArtifactPattern(path)) {
      continue;
    }

    let beforeContent: string | undefined;
    try {
      beforeContent = await git.fileContent(cwd, headBeforeFix, path);
    } catch {
      beforeContent = undefined;
    }
    const beforeHash = hashContent(beforeContent);

    let afterContent: string | undefined;
    try {
      afterContent = await git.fileContent(cwd, headAfterFix, path);
    } catch {
      afterContent = undefined;
    }
    const afterHash = hashContent(afterContent);

    if (beforeHash === afterHash) {
      continue;
    }

    results.push({
      path,
      beforeHash,
      afterHash,
      diagnostic,
      ...(recordedAtIteration !== undefined ? { recordedAtIteration } : {}),
    });
  }

  return results;
}

/**
 * Checks whether current content matches the pre-fix state of a validation-critical file.
 */
export function wasRevertedToBeforeState(input: {
  currentHash: string;
  critical: ValidationCriticalFile;
}): boolean {
  return input.currentHash === input.critical.beforeHash;
}

/**
 * Formats a carve-out warning block for prompts / history context.
 */
export function formatValidationCriticalFilesWarning(files: ValidationCriticalFile[]): string {
  if (!Array.isArray(files) || files.length === 0) {
    return '';
  }

  const lines: string[] = [
    '### Validation-Critical Files (Do Not Revert)',
    '',
    'The following file(s) were modified to satisfy a validation command that was previously failing on their prior content:',
  ];
  for (const f of files) {
    const diag = f.diagnostic ? ` (${f.diagnostic})` : '';
    lines.push(`- \`${f.path}\`${diag}`);
  }
  lines.push(
    '',
    'Do not instruct reverting or restoring them to prior states. If you believe a change is unnecessary or wrong, you must say so explicitly and note that reverting requires re-running the command to confirm it still passes — do not silently recommend restoring the file to its prior state.',
  );
  return lines.join('\n');
}

/**
 * Checks whether any changed file in a fix commit reverted a validation-critical file to its pre-fix state.
 */
export async function checkValidationCriticalRevert(input: {
  git: GitPort;
  cwd: string;
  changedFiles: readonly string[];
  critical: ReadonlyMap<string, ValidationCriticalFile>;
  headAfterFix: string;
}): Promise<{ reverted: boolean; path?: string; diagnostic?: string }> {
  const { git, cwd, changedFiles, critical, headAfterFix } = input;
  if (critical.size === 0 || changedFiles.length === 0) {
    return { reverted: false };
  }

  for (const rawPath of changedFiles) {
    const norm = normalizeRepositoryPath(rawPath, cwd);
    if (!norm) {
      continue;
    }
    const crit = critical.get(norm);
    if (!crit) {
      continue;
    }

    let content: string | undefined;
    try {
      content = await git.fileContent(cwd, headAfterFix, norm);
    } catch {
      content = undefined;
    }
    const currentHash = hashContent(content);
    if (wasRevertedToBeforeState({ currentHash, critical: crit })) {
      return { reverted: true, path: norm, diagnostic: crit.diagnostic };
    }
  }

  return { reverted: false };
}

import { existsSync, realpathSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import type { TypescriptError } from '@ai-sdlc/application';

const EXCLUDED_PATH_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.next',
  '.ai-runs',
  '.ai-tmp',
]);

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

function isExcludedPath(path: string): boolean {
  const normalized = normalizeSeparators(path);
  return normalized.split('/').some((seg) => EXCLUDED_PATH_SEGMENTS.has(seg));
}

function hasSupportedExtension(path: string): boolean {
  const normalized = normalizeSeparators(path);
  const lastSep = normalized.lastIndexOf('/');
  const filename = lastSep >= 0 ? normalized.slice(lastSep + 1) : normalized;
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex < 0) return false;
  const ext = filename.slice(dotIndex);
  return SUPPORTED_EXTENSIONS.has(ext);
}

function isGeneratedFile(path: string): boolean {
  const normalized = normalizeSeparators(path);
  return /\.(?:d\.ts|d\.tsx|d\.mts|d\.cts)$/.test(normalized);
}

function resolveAndCheckContainment(
  worktreeRootResolved: string,
  rootRealpathNormalized: string,
  candidate: string,
): string | null {
  try {
    const normalizedCandidate = normalizeSeparators(candidate);

    if (
      normalizedCandidate.startsWith('/') &&
      !normalizedCandidate.startsWith(worktreeRootResolved + '/')
    ) {
      return null;
    }

    if (normalizedCandidate.includes('..')) {
      const resolved = resolve(worktreeRootResolved, normalizedCandidate);
      const normalizedResolved = normalizeSeparators(resolved);
      if (!normalizedResolved.startsWith(worktreeRootResolved + '/')) {
        return null;
      }
    }

    let fullPath: string;
    if (isAbsolute(normalizedCandidate)) {
      fullPath = normalizeSeparators(normalizedCandidate);
    } else {
      fullPath = normalizeSeparators(resolve(worktreeRootResolved, normalizedCandidate));
    }

    const realpath = realpathSync(fullPath);
    const realpathNormalized = normalizeSeparators(realpath);

    if (
      !realpathNormalized.startsWith(rootRealpathNormalized + '/') &&
      realpathNormalized !== rootRealpathNormalized
    ) {
      return null;
    }

    if (!existsSync(fullPath)) {
      return null;
    }

    const normalizedFullPath = normalizeSeparators(fullPath);

    let relativePath: string;
    if (normalizedFullPath.startsWith(worktreeRootResolved + '/')) {
      relativePath = normalizedFullPath.replace(worktreeRootResolved + '/', '');
    } else {
      relativePath = realpathNormalized.replace(rootRealpathNormalized + '/', '');
    }

    return relativePath;
  } catch {
    return null;
  }
}

export function deriveTrustedImplicatedFiles(
  worktreeRoot: string,
  errors: readonly TypescriptError[],
): string[] {
  const worktreeRootResolved = normalizeSeparators(resolve(worktreeRoot));
  const rootRealpath = realpathSync(worktreeRootResolved);
  const rootRealpathNormalized = normalizeSeparators(rootRealpath);
  const seen = new Set<string>();
  const seenCandidatePaths = new Set<string>();
  const result: string[] = [];

  for (const error of errors) {
    const file = error.file?.trim();
    if (!file) continue;

    const normalizedFile = normalizeSeparators(file);

    if (isExcludedPath(normalizedFile)) continue;
    if (isGeneratedFile(normalizedFile)) continue;
    if (!hasSupportedExtension(normalizedFile)) continue;
    if (seenCandidatePaths.has(normalizedFile)) continue;
    seenCandidatePaths.add(normalizedFile);

    const contained = resolveAndCheckContainment(
      worktreeRootResolved,
      rootRealpathNormalized,
      normalizedFile,
    );
    if (!contained) continue;

    const normalizedContained = normalizeSeparators(contained);
    if (seen.has(normalizedContained)) continue;
    seen.add(normalizedContained);
    result.push(normalizedContained);
  }

  result.sort();
  return result;
}

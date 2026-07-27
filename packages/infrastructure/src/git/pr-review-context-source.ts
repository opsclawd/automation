import { isAbsolute, resolve } from 'node:path';
import { git } from './git-runner.js';
import type {
  PrReviewContextSnapshot,
  PrReviewContextSourcePort,
} from '@ai-sdlc/application/ports';

export const MAX_CONTEXT_FILES = 50;
export const MAX_FILE_CHARS = 100_000;
export const MAX_SNAPSHOT_CHARS = 500_000;

function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function isPathConfined(cwd: string, filePath: string): boolean {
  if (isAbsolute(filePath)) return false;
  const normalized = resolve(cwd, filePath);
  const cwdPosix = toPosixPath(cwd);
  const normalizedPosix = toPosixPath(normalized);
  if (!normalizedPosix.startsWith(cwdPosix + '/')) return false;
  const parts = filePath.split('/');
  if (parts.includes('..')) return false;
  return true;
}

function getSiblingTestCandidates(filePath: string): string[] {
  const lastSlash = filePath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? filePath.slice(0, lastSlash + 1) : '';
  const basename = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;

  const extMatch = basename.match(/^(.+)\.(\w+)$/);
  if (!extMatch) return [];

  const [, name, ext] = extMatch;
  const candidates: string[] = [];

  const testSuffixes = ['.test', '.spec', '.tests'];
  for (const suffix of testSuffixes) {
    candidates.push(`${dir}${name}${suffix}.${ext}`);
  }

  return candidates;
}

async function tryReadFileAtHead(
  cwd: string,
  head: string,
  filePath: string,
): Promise<string | null> {
  try {
    const output = await git(cwd, ['show', `${head}:${filePath}`]);
    return output;
  } catch {
    return null;
  }
}

async function isBinaryFile(cwd: string, head: string, filePath: string): Promise<boolean> {
  try {
    await git(cwd, ['show', `--word-diff=porcelain`, `${head}:${filePath}`]);
    return false;
  } catch {
    return true;
  }
}

export function createPrReviewContextSource(): PrReviewContextSourcePort {
  return async function prReviewContextSource(input: {
    cwd: string;
    base: string;
    head: string;
    seedPaths: readonly string[];
  }): Promise<PrReviewContextSnapshot> {
    const { cwd, base, head, seedPaths } = input;

    for (const seedPath of seedPaths) {
      if (!isPathConfined(cwd, seedPath)) {
        throw new Error(`seed path must be relative and must not escape: ${seedPath}`);
      }
    }

    const fullDiff = await git(cwd, ['diff', base, head]);
    const diffStat = await git(cwd, ['diff', '--stat', `${base}..${head}`]);

    const changedFilesOutput = await git(cwd, ['diff', '-z', '--name-only', `${base}..${head}`]);
    const changedFiles = changedFilesOutput
      .split('\0')
      .map((p) => p.trim().replace(/\\/g, '/'))
      .filter(Boolean)
      .sort();

    const trackedFilesOutput = await git(cwd, ['ls-files']);
    const trackedFiles = trackedFilesOutput
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => toPosixPath(p));

    const priorityFiles: string[] = [];

    for (const seedPath of seedPaths) {
      const posixSeed = toPosixPath(seedPath);
      if (!priorityFiles.includes(posixSeed)) {
        priorityFiles.push(posixSeed);
      }
      const siblings = getSiblingTestCandidates(seedPath);
      for (const sibling of siblings) {
        if (!priorityFiles.includes(sibling)) {
          priorityFiles.push(sibling);
        }
      }
    }

    const remainingSlots = MAX_CONTEXT_FILES - priorityFiles.length;
    const changedFilesToAdd = changedFiles
      .filter((f) => !priorityFiles.includes(f))
      .slice(0, Math.max(0, remainingSlots));

    const allFilesToProcess = [...priorityFiles, ...changedFilesToAdd];

    let totalChars = 0;
    const fileContents: Record<string, string> = {};

    for (const filePath of allFilesToProcess) {
      if (totalChars >= MAX_SNAPSHOT_CHARS) break;

      const content = await tryReadFileAtHead(cwd, head, filePath);
      if (content === null) continue;

      if (await isBinaryFile(cwd, head, filePath)) continue;

      const truncated =
        content.length > MAX_FILE_CHARS ? content.slice(0, MAX_FILE_CHARS) : content;

      if (totalChars + truncated.length > MAX_SNAPSHOT_CHARS) {
        const remaining = MAX_SNAPSHOT_CHARS - totalChars;
        if (remaining > 0) {
          fileContents[filePath] = truncated.slice(0, remaining);
          totalChars += remaining;
        }
        break;
      }

      fileContents[filePath] = truncated;
      totalChars += truncated.length;
    }

    return Object.freeze({
      base,
      head,
      fullDiff,
      diffStat,
      changedFiles: Object.freeze([...changedFiles]),
      trackedFiles: Object.freeze([...trackedFiles]),
      fileContents: Object.freeze({ ...fileContents }),
    });
  };
}

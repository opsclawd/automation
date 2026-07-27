import { isAbsolute, relative, resolve } from 'node:path';
import { execa } from 'execa';
import { git } from './git-runner.js';
import type {
  PrReviewContextSnapshot,
  PrReviewContextSourcePort,
} from '@ai-sdlc/application/ports';

function findRelativeImports(content: string): string[] {
  const imports: string[] = [];
  const regex = /(?:from\s+|import\s+)['"]((\.{1,2}(?:\/[^'"]*)?))['"]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (match[1]) {
      imports.push(match[1]);
    }
  }
  return imports;
}

function resolveRelativeImport(basePath: string, importPath: string): string {
  const parts = basePath.split('/');
  parts.pop();
  const importParts = importPath.split('/');
  const excessDots: string[] = [];
  for (const part of importParts) {
    if (part === '..') {
      if (parts.length > 0) {
        parts.pop();
      } else {
        excessDots.push('..');
      }
    } else if (part !== '.') {
      parts.push(part);
    }
  }
  return [...excessDots, ...parts].join('/');
}

export const MAX_CONTEXT_FILES = 50;
export const MAX_FILE_CHARS = 100_000;
export const MAX_SNAPSHOT_CHARS = 500_000;

function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function isPathConfined(cwd: string, filePath: string): boolean {
  if (isAbsolute(filePath)) return false;
  const parts = filePath.split('/');
  if (parts.includes('..')) return false;
  const normalized = resolve(cwd, filePath);
  const rel = relative(cwd, normalized);
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
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
    candidates.push(`${dir}__tests__/${name}${suffix}.${ext}`);
  }

  return candidates;
}

async function tryReadFileAtHead(
  cwd: string,
  head: string,
  filePath: string,
): Promise<{ content: string | null; isBinary: boolean }> {
  try {
    const { stdout } = await execa('git', ['show', `${head}:${filePath}`], {
      cwd,
      encoding: 'buffer',
      stripFinalNewline: false,
      timeout: 30_000,
    });
    const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      const content = decoder.decode(buffer);
      return { content, isBinary: false };
    } catch {
      return { content: null, isBinary: true };
    }
  } catch {
    return { content: null, isBinary: false };
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
      .map((p) => p.replace(/\\/g, '/'))
      .filter(Boolean)
      .sort();

    const trackedFilesOutput = await git(cwd, ['ls-tree', '-r', '--name-only', '-z', head]);
    const trackedFiles = trackedFilesOutput
      .split('\0')
      .filter(Boolean)
      .map((p) => toPosixPath(p));

    const priorityFiles: string[] = [];

    for (const seedPath of seedPaths) {
      const posixSeed = toPosixPath(seedPath);
      if (!priorityFiles.includes(posixSeed)) {
        priorityFiles.push(posixSeed);
      }
      const siblings = getSiblingTestCandidates(posixSeed);
      for (const sibling of siblings) {
        if (!priorityFiles.includes(sibling)) {
          priorityFiles.push(sibling);
        }
      }
      const { content: seedContent } = await tryReadFileAtHead(cwd, head, posixSeed);
      if (seedContent) {
        const relativeImports = findRelativeImports(seedContent);
        for (const imp of relativeImports) {
          const resolved = resolveRelativeImport(posixSeed, imp);
          const isJsImport = resolved.endsWith('.js');
          if (!priorityFiles.includes(resolved)) {
            priorityFiles.push(resolved);
          }
          if (isJsImport) {
            const tsResolved = resolved.replace(/\.js$/, '.ts');
            const tsxResolved = resolved.replace(/\.js$/, '.tsx');
            if (!priorityFiles.includes(tsResolved)) {
              priorityFiles.push(tsResolved);
            }
            if (!priorityFiles.includes(tsxResolved)) {
              priorityFiles.push(tsxResolved);
            }
          }
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
      if (Object.keys(fileContents).length >= MAX_CONTEXT_FILES) break;

      const { content, isBinary } = await tryReadFileAtHead(cwd, head, filePath);
      if (content === null || isBinary) continue;

      let truncated = content.length > MAX_FILE_CHARS ? content.slice(0, MAX_FILE_CHARS) : content;
      if (truncated.length === MAX_FILE_CHARS && content.length > MAX_FILE_CHARS) {
        const charCode = truncated.charCodeAt(truncated.length - 1);
        if (charCode >= 0xd800 && charCode <= 0xdbff) {
          truncated = truncated.slice(0, -1);
        }
      }

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

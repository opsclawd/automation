export interface ParsedHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly body: string;
  readonly additions: number;
  readonly deletions: number;
  readonly isNew: boolean;
  readonly isDeleted: boolean;
  readonly isBinary: boolean;
  readonly identity: string;
}

export interface ParsedUnifiedDiff {
  readonly hunks: ReadonlyMap<string, readonly ParsedHunk[]>;
  readonly files: readonly string[];
  readonly diffStat: string;
  readonly parseError?: string;
}

interface HunkHeader {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

function generateHunkIdentity(
  path: string,
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
): string {
  return `${path}:${oldStart},${oldLines}:${newStart},${newLines}`;
}

function finalizeHunk(
  hunks: Map<string, ParsedHunk[]>,
  file: string,
  header: HunkHeader,
  body: readonly string[],
  additions: number,
  deletions: number,
  isNew: boolean,
  isDeleted: boolean,
  isBinary: boolean,
): void {
  const identity = generateHunkIdentity(
    file,
    header.oldStart,
    header.oldLines,
    header.newStart,
    header.newLines,
  );
  const newHunk: ParsedHunk = {
    oldStart: header.oldStart,
    oldLines: header.oldLines,
    newStart: header.newStart,
    newLines: header.newLines,
    body: body.join('\n'),
    additions,
    deletions,
    isNew,
    isDeleted,
    isBinary,
    identity,
  };
  const existing = hunks.get(file);
  if (existing) {
    existing.push(newHunk);
  } else {
    hunks.set(file, [newHunk]);
  }
}

function parseHunkHeader(line: string): HunkHeader | null {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match || !match[1] || !match[3]) return null;
  return {
    oldStart: parseInt(match[1], 10),
    oldLines: match[2] ? parseInt(match[2], 10) : 1,
    newStart: parseInt(match[3], 10),
    newLines: match[4] ? parseInt(match[4], 10) : 1,
  };
}

function unquotePath(path: string): string {
  if (path.startsWith('"') && path.endsWith('"')) {
    return path.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return path;
}

function parseOldNewPaths(headerLines: string[]): {
  oldPath: string | null;
  newPath: string | null;
} {
  let oldPath: string | null = null;
  let newPath: string | null = null;

  for (const line of headerLines) {
    if (line.startsWith('--- ')) {
      const path = line.slice(4).trim();
      if (path === '/dev/null') {
        oldPath = null;
      } else {
        const unquoted = unquotePath(path);
        oldPath = unquoted.replace(/^a\//, '');
      }
    } else if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      if (path === '/dev/null') {
        newPath = null;
      } else {
        const unquoted = unquotePath(path);
        newPath = unquoted.replace(/^b\//, '');
      }
    }
  }

  return { oldPath, newPath };
}

// Best-effort fallback for extracting a path from the "diff --git" line itself,
// used only when there is no "--- "/"+++ " header to rely on (e.g. binary diffs).
// The greedy match backtracks to the *last* " b/" in the line, which matches
// git's own convention of mirroring the a/ and b/ paths and avoids truncating
// at an earlier " b/" substring that happens to appear inside the path.
function parseDiffGitLine(line: string): string | null {
  const match = line.match(/^diff --git "?a\/(.+)"? b\//);
  return match && match[1] ? unquotePath(match[1]) : null;
}

export function parseUnifiedDiff(diff: string): ParsedUnifiedDiff {
  if (!diff || diff.trim() === '') {
    return { hunks: new Map(), files: [], diffStat: '' };
  }

  const hunks = new Map<string, ParsedHunk[]>();
  const files: string[] = [];

  const lines = diff.split('\n');
  let currentFile: string | null = null;
  let currentHunkHeader: HunkHeader | null = null;
  let currentHunkBody: string[] = [];
  let headerLines: string[] = [];
  let additions = 0;
  let deletions = 0;
  let isBinary = false;
  let isNew = false;
  let isDeleted = false;
  let parseError: string | undefined;

  try {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;

      if (line.startsWith('diff --git') || line.startsWith('--- ') || line.startsWith('diff --')) {
        if (currentFile && currentHunkHeader !== null) {
          finalizeHunk(
            hunks,
            currentFile,
            currentHunkHeader,
            currentHunkBody,
            additions,
            deletions,
            isNew,
            isDeleted,
            isBinary,
          );
        }

        if (line.startsWith('diff --git')) {
          currentFile = parseDiffGitLine(line);
          headerLines = [line];
        } else if (line.startsWith('--- ')) {
          headerLines.push(line);
          const { oldPath, newPath } = parseOldNewPaths([line]);
          if (oldPath === null && newPath !== null) {
            currentFile = newPath;
            isNew = true;
          } else if (oldPath !== null && newPath === null) {
            currentFile = oldPath;
            isDeleted = true;
          } else if (oldPath) {
            currentFile = oldPath;
          }
        }

        currentHunkHeader = null;
        currentHunkBody = [];
        additions = 0;
        deletions = 0;
        isBinary = false;
        isNew = false;
        isDeleted = false;
      } else if (line.startsWith('+++ ')) {
        headerLines.push(line);
        const { oldPath, newPath } = parseOldNewPaths(headerLines);
        if (newPath) currentFile = newPath;
        if (oldPath === null && newPath !== null) isNew = true;
        if (oldPath !== null && newPath === null) isDeleted = true;
      } else if (line.startsWith('@@')) {
        const header = parseHunkHeader(line);
        if (header) {
          if (currentHunkHeader !== null && currentFile) {
            finalizeHunk(
              hunks,
              currentFile,
              currentHunkHeader,
              currentHunkBody,
              additions,
              deletions,
              isNew,
              isDeleted,
              isBinary,
            );
          }
          currentHunkHeader = header;
          currentHunkBody = [line];
          additions = 0;
          deletions = 0;
        } else if (!parseError) {
          parseError = `Malformed hunk header at line ${i + 1}: ${line}`;
        }
      } else if (currentHunkHeader !== null) {
        currentHunkBody.push(line);
        if (line.startsWith('+') && !line.startsWith('+++')) {
          additions++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          deletions++;
        }
      } else if (line.includes('Binary files') && currentFile) {
        isBinary = true;
        if (!files.includes(currentFile)) {
          files.push(currentFile);
        }
        finalizeHunk(
          hunks,
          currentFile,
          { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0 },
          [line],
          0,
          0,
          false,
          false,
          true,
        );
      }
    }

    if (currentFile && currentHunkHeader !== null) {
      finalizeHunk(
        hunks,
        currentFile,
        currentHunkHeader,
        currentHunkBody,
        additions,
        deletions,
        isNew,
        isDeleted,
        isBinary,
      );
    }
  } catch (e) {
    parseError = e instanceof Error ? e.message : String(e);
  }

  for (const path of hunks.keys()) {
    if (!files.includes(path)) {
      files.push(path);
    }
  }

  const diffStatLines: string[] = [];
  for (const [path, hunkList] of hunks) {
    const firstHunk = hunkList[0];
    if (firstHunk?.isBinary) {
      diffStatLines.push(`${path} | Binary`);
    } else {
      const totalAdditions = hunkList.reduce((sum, h) => sum + h.additions, 0);
      const totalDeletions = hunkList.reduce((sum, h) => sum + h.deletions, 0);
      diffStatLines.push(`${path} | ${totalAdditions} +, ${totalDeletions} -`);
    }
  }

  const result: ParsedUnifiedDiff = {
    hunks,
    files,
    diffStat: diffStatLines.join('\n'),
    ...(parseError !== undefined ? { parseError } : {}),
  };
  return result;
}

export function findHunkForLine(
  hunks: ReadonlyMap<string, readonly ParsedHunk[]>,
  path: string,
  line: number,
): ParsedHunk | undefined {
  const hunkList = hunks.get(path);
  if (!hunkList) return undefined;

  for (const hunk of hunkList) {
    if (line >= hunk.newStart && line < hunk.newStart + hunk.newLines) {
      return hunk;
    }
  }

  return undefined;
}

export function extractBoundedSourceContext(
  lines: readonly string[],
  line: number,
  contextSize: number = 20,
): string {
  const start = Math.max(0, line - contextSize - 1);
  const end = Math.min(lines.length, line + contextSize);
  return lines.slice(start, end).join('\n');
}

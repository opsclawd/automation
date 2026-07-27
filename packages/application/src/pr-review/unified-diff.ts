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
  readonly hunks: ReadonlyMap<string, ParsedHunk>;
  readonly files: readonly string[];
  readonly diffStat: string;
  readonly parseError?: string;
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

function parseHunkHeader(
  line: string,
): { oldStart: number; oldLines: number; newStart: number; newLines: number } | null {
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
      if (path === '/dev/null' || path === '/dev/null') {
        newPath = null;
      } else {
        const unquoted = unquotePath(path);
        newPath = unquoted.replace(/^b\//, '');
      }
    }
  }

  return { oldPath, newPath };
}

export function parseUnifiedDiff(diff: string): ParsedUnifiedDiff {
  if (!diff || diff.trim() === '') {
    return { hunks: new Map(), files: [], diffStat: '' };
  }

  const hunks = new Map<string, ParsedHunk>();
  const files: string[] = [];

  const lines = diff.split('\n');
  let currentFile: string | null = null;
  let currentHunkHeader: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
  } | null = null;
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
          const identity = generateHunkIdentity(
            currentFile,
            currentHunkHeader.oldStart,
            currentHunkHeader.oldLines,
            currentHunkHeader.newStart,
            currentHunkHeader.newLines,
          );
          hunks.set(currentFile, {
            oldStart: currentHunkHeader.oldStart,
            oldLines: currentHunkHeader.oldLines,
            newStart: currentHunkHeader.newStart,
            newLines: currentHunkHeader.newLines,
            body: currentHunkBody.join('\n'),
            additions,
            deletions,
            isNew,
            isDeleted,
            isBinary,
            identity,
          });
        }

        if (line.startsWith('diff --git')) {
          const match = line.match(/^diff --git "?a\/(.+?)"? b\//);
          if (match && match[1]) {
            currentFile = unquotePath(match[1]);
            headerLines = [line];
          }
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
            const identity = generateHunkIdentity(
              currentFile,
              currentHunkHeader.oldStart,
              currentHunkHeader.oldLines,
              currentHunkHeader.newStart,
              currentHunkHeader.newLines,
            );
            hunks.set(currentFile, {
              oldStart: currentHunkHeader.oldStart,
              oldLines: currentHunkHeader.oldLines,
              newStart: currentHunkHeader.newStart,
              newLines: currentHunkHeader.newLines,
              body: currentHunkBody.join('\n'),
              additions,
              deletions,
              isNew,
              isDeleted,
              isBinary,
              identity,
            });
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
        const identity = generateHunkIdentity(currentFile, 0, 0, 0, 0);
        hunks.set(currentFile, {
          oldStart: 0,
          oldLines: 0,
          newStart: 0,
          newLines: 0,
          body: line,
          additions: 0,
          deletions: 0,
          isNew: false,
          isDeleted: false,
          isBinary: true,
          identity,
        });
      }
    }

    if (currentFile && currentHunkHeader !== null) {
      const identity = generateHunkIdentity(
        currentFile,
        currentHunkHeader.oldStart,
        currentHunkHeader.oldLines,
        currentHunkHeader.newStart,
        currentHunkHeader.newLines,
      );
      hunks.set(currentFile, {
        oldStart: currentHunkHeader.oldStart,
        oldLines: currentHunkHeader.oldLines,
        newStart: currentHunkHeader.newStart,
        newLines: currentHunkHeader.newLines,
        body: currentHunkBody.join('\n'),
        additions,
        deletions,
        isNew,
        isDeleted,
        isBinary,
        identity,
      });
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
  for (const [path, hunk] of hunks) {
    if (hunk.isBinary) {
      diffStatLines.push(`${path} | Binary`);
    } else {
      diffStatLines.push(`${path} | ${hunk.additions} +, ${hunk.deletions} -`);
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
  hunks: ReadonlyMap<string, ParsedHunk>,
  path: string,
  line: number,
): ParsedHunk | undefined {
  const hunk = hunks.get(path);
  if (!hunk) return undefined;

  if (line >= hunk.newStart && line < hunk.newStart + hunk.newLines) {
    return hunk;
  }

  return hunk;
}

export function extractBoundedSourceContext(
  fileContent: string,
  line: number,
  contextSize: number = 20,
): string {
  const lines = fileContent.split('\n');
  const start = Math.max(0, line - contextSize - 1);
  const end = Math.min(lines.length, line + contextSize);
  return lines.slice(start, end).join('\n');
}

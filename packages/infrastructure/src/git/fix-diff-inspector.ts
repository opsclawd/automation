import type {
  FixDiffInspectionResult,
  FixDiffInspectorInput,
  FixDiffInspectorPort,
} from '@ai-sdlc/application/ports';
import { git } from './git-runner.js';

const DEFAULT_PROXIMITY_WINDOW = 5;

/**
 * Parse a unified-diff hunk header (`@@ -oldStart,oldCount +newStart,newCount @@`)
 * and return the numeric fields. Returns `undefined` for unparseable lines.
 */
function parseHunkHeader(
  header: string,
): { oldStart: number; oldCount: number; newStart: number; newCount: number } | undefined {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!m) return undefined;
  return {
    oldStart: Number(m[1]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === undefined ? 1 : Number(m[4]),
  };
}

interface DiffHunk {
  readonly oldPath: string;
  readonly newPath: string;
  readonly oldStart: number;
  readonly newStart: number;
  readonly oldCount: number;
  readonly newCount: number;
  /** +/-/space-prefixed body lines of the hunk, in order. */
  readonly bodyLines: readonly string[];
}

/**
 * Parse a unified diff into per-file hunks. Robust to garbage: any
 * hunk with an unparseable header is silently dropped (caller falls
 * back to `nearLine: 'skipped'`).
 */
function parseUnifiedDiff(raw: string): DiffHunk[] {
  const lines = raw.split('\n');
  const hunks: DiffHunk[] = [];
  let i = 0;
  let currentOld = '';
  let currentNew = '';
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('--- ')) {
      currentOld = line.slice(4).split('\t')[0]!.replace(/^a\//, '');
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      currentNew = line.slice(4).split('\t')[0]!.replace(/^b\//, '');
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const header = parseHunkHeader(line);
      if (!header) {
        i++;
        continue;
      }
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('@@')) {
        body.push(lines[i]!);
        i++;
      }
      hunks.push({
        oldPath: currentOld,
        newPath: currentNew,
        oldStart: header.oldStart,
        newStart: header.newStart,
        oldCount: header.oldCount,
        newCount: header.newCount,
        bodyLines: body,
      });
      continue;
    }
    i++;
  }
  return hunks;
}

interface ParsedAccumulated {
  readonly added: number;
  readonly removed: number;
}

/**
 * Compute the net line delta on `path` between two SHAs. Returns
 * `{added, removed}` for the diff `original..running`. Used by the
 * shift translator.
 */
async function accumulatedLineDelta(
  cwd: string,
  original: string,
  running: string,
  path: string,
): Promise<ParsedAccumulated> {
  let added = 0;
  let removed = 0;
  try {
    const out = await git(cwd, [
      'diff',
      '--unified=0',
      '--no-color',
      `${original}..${running}`,
      '--',
      path,
    ]);
    const hunks = parseUnifiedDiff(out);
    for (const h of hunks) {
      for (const body of h.bodyLines) {
        if (body.startsWith('+') && !body.startsWith('+++')) added++;
        else if (body.startsWith('-') && !body.startsWith('---')) removed++;
      }
    }
  } catch {
    // missing file in either side or other git error; translation is unsafe.
  }
  return { added, removed };
}

interface FixDiffInspectorAdapterDeps {
  readonly proximityWindow?: number;
}

/**
 * Factory that returns a `FixDiffInspectorPort` ready for injection.
 *
 * Behavior contract:
 *  - File-touched: always runs. Parses `git diff <runningStartSha>..<fixCommitSha> -- <path>`
 *    and returns `touchesPath: true` iff at least one hunk references `path`.
 *  - Line-proximity:
 *      * If `originalStartCommitSha === runningStartSha` (no
 *        accumulated diff), the hunk's `newStart` (or `oldStart`
 *        for deleted hunks) is compared directly.
 *      * If they differ, an accumulated diff between the two SHAs is
 *        parsed; if the translation succeeds, proximity is computed
 *        on the translated line. If it fails, the inspector returns
 *        `nearLine: 'skipped'` (never false on translation failure).
 *  - Malformed input never throws — the worst case is `nearLine: 'skipped'`.
 */
export function createFixDiffInspector(
  deps: FixDiffInspectorAdapterDeps = {},
): FixDiffInspectorPort {
  const window = deps.proximityWindow ?? DEFAULT_PROXIMITY_WINDOW;

  return async (input: FixDiffInspectorInput): Promise<FixDiffInspectionResult> => {
    // Step 1: file-touched check.
    let diffText = '';
    try {
      diffText = await git(input.cwd, [
        'diff',
        '--no-color',
        `${input.runningStartSha}..${input.fixCommitSha}`,
        '--',
        input.path,
      ]);
    } catch {
      // Path is not tracked in either side; treat as untouched.
      return {
        touchesPath: false,
        nearLine: 'skipped',
        reason: `fix commit ${input.fixCommitSha.slice(0, 7)} does not touch ${input.path}`,
      };
    }
    const fixHunks = parseUnifiedDiff(diffText).filter(
      (h) => h.oldPath === input.path || h.newPath === input.path,
    );
    if (fixHunks.length === 0) {
      return {
        touchesPath: false,
        nearLine: 'skipped',
        reason: `fix commit ${input.fixCommitSha.slice(0, 7)} does not touch ${input.path}`,
      };
    }

    // Step 2: line-proximity — decide whether to translate.
    let targetLine = input.line;
    let skippedReason = '';
    if (input.originalStartCommitSha !== input.runningStartSha) {
      const acc = await accumulatedLineDelta(
        input.cwd,
        input.originalStartCommitSha,
        input.runningStartSha,
        input.path,
      );
      if (acc.removed !== acc.added) {
        // Linear, unambiguous translation when the net delta is constant.
        targetLine = input.line + (acc.added - acc.removed);
      } else if (acc.added === 0 && acc.removed === 0) {
        // No diff on this path between the two SHAs; nothing to translate.
        skippedReason = '';
      } else {
        skippedReason = `accumulated diff on ${input.path} is ambiguous (added=${acc.added}, removed=${acc.removed})`;
        return {
          touchesPath: true,
          nearLine: 'skipped',
          reason: skippedReason,
        };
      }
    }

    // Step 3: walk the hunk(s) and check for any +/- line within ±window of `targetLine`.
    for (const hunk of fixHunks) {
      let newLineNo = hunk.newStart;
      let oldLineNo = hunk.oldStart;
      for (const body of hunk.bodyLines) {
        if (body.startsWith('+') && !body.startsWith('+++')) {
          if (Math.abs(newLineNo - targetLine) <= window) {
            return { touchesPath: true, nearLine: true, reason: '' };
          }
          newLineNo++;
        } else if (body.startsWith('-') && !body.startsWith('---')) {
          if (Math.abs(oldLineNo - targetLine) <= window) {
            return { touchesPath: true, nearLine: true, reason: '' };
          }
          oldLineNo++;
        } else if (body.startsWith(' ')) {
          newLineNo++;
          oldLineNo++;
        }
        // "\ No newline at end of file" markers are ignored.
      }
    }

    return {
      touchesPath: true,
      nearLine: false,
      reason: `fix commit touches ${input.path} but no changed line within \xb1${window} of comment line ${input.line}`,
    };
  };
}

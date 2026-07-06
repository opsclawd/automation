import type {
  FindingEvidenceCheckInput,
  FindingEvidenceCheckResult,
  FindingEvidenceInspectorPort,
} from '@ai-sdlc/application/ports';
import { git } from './git-runner.js';

/**
 * Normalize a snippet for whitespace-tolerant comparison: collapse runs of
 * whitespace (including newlines) into a single space and trim. Mirrors the
 * approach used by `normalizeTypecheckOutput` in `implement-step-loop.ts`.
 */
function normalizeSnippet(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Read the file at `path` on `ref` from `cwd`. Returns `undefined` if the
 * file does not exist at that ref or `git show` fails.
 */
async function readFileAtRef(cwd: string, ref: string, path: string): Promise<string | undefined> {
  try {
    const typeOut = await git(cwd, ['cat-file', '-t', `${ref}:${path}`]);
    if (typeOut.trim() !== 'blob') {
      return undefined;
    }
    const out = await git(cwd, ['cat-file', '-p', `${ref}:${path}`]);
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Find a normalized snippet in `fileContents` within ±5 lines of `targetLine`
 * (when targetLine is set), or anywhere in the file otherwise. Mirrors the
 * proximity window used by `FixDiffInspectorPort`.
 */
function snippetNearLine(
  fileContents: string,
  snippet: string,
  targetLine: number | undefined,
): { found: boolean; reason: string } {
  const needle = normalizeSnippet(snippet);
  if (!needle) return { found: false, reason: 'snippet is empty after normalization' };

  const lines = fileContents.split('\n');
  const searchLines =
    targetLine === undefined
      ? lines
      : lines.slice(Math.max(0, targetLine - 6), Math.min(lines.length, targetLine + 5));

  const haystack = normalizeSnippet(searchLines.join('\n'));
  if (haystack.includes(needle)) {
    return { found: true, reason: '' };
  }
  return {
    found: false,
    reason: `snippet not found within ±5 lines of ${targetLine ?? 'file'}`,
  };
}

export function createFindingEvidenceInspector(): FindingEvidenceInspectorPort {
  return async (input: FindingEvidenceCheckInput): Promise<FindingEvidenceCheckResult> => {
    if (!input.evidence.path || input.evidence.path.endsWith('/')) {
      return {
        evidenceConfirmed: false,
        reason: `path '${input.evidence.path}' is empty or invalid`,
      };
    }

    // Step 1: file existence check.
    const fileContents = await readFileAtRef(input.cwd, input.ref, input.evidence.path);
    if (fileContents === undefined) {
      return {
        evidenceConfirmed: false,
        reason: `path '${input.evidence.path}' does not exist at ref ${input.ref}`,
      };
    }

    // Step 2: line-range check (if line is provided).
    if (input.evidence.line !== undefined) {
      const lines = fileContents.split('\n');
      if (input.evidence.line < 1 || input.evidence.line > lines.length) {
        return {
          evidenceConfirmed: false,
          reason: `line ${input.evidence.line} is out of range (file has ${lines.length} lines)`,
        };
      }
    }

    // Step 3: snippet check (if snippet is provided).
    if (input.evidence.snippet !== undefined) {
      const result = snippetNearLine(fileContents, input.evidence.snippet, input.evidence.line);
      if (!result.found) {
        return { evidenceConfirmed: false, reason: result.reason };
      }
    }

    return { evidenceConfirmed: true, reason: 'evidence confirmed' };
  };
}

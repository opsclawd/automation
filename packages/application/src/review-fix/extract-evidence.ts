import type { FindingEvidence } from '../ports/finding-evidence-inspector-port.js';

/**
 * Extract structural evidence (path:line references + fenced code snippets)
 * from a reviewer's `code-review.md` markdown.
 *
 * Strategy:
 *   1. Inline backtick references matching `path/to/file.ext:NN` (1-based line)
 *      become `path + line` entries.
 *   2. Fenced code blocks become `snippet` entries. The path is inferred from
 *      the closest preceding bold line `**path/to/file.ext**`; if no preceding
 *      bold path exists, the snippet is returned with `path: undefined`
 *      discarded (callers treat path-less snippets as soft evidence).
 *   3. Pure / deterministic. Never throws; returns `[]` on unparseable input.
 */
export function extractEvidence(markdown: string): FindingEvidence[] {
  if (typeof markdown !== 'string' || markdown.length === 0) return [];

  const results: FindingEvidence[] = [];
  const lines = markdown.split('\n');

  let currentBoldPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Match bold path line: **some/path.ts**
    const boldMatch = /^\s*\*\*([^\s*]+)\*\*\s*:?\s*$/.exec(line);
    if (boldMatch) {
      currentBoldPath = boldMatch[1];
      i++;
      continue;
    }

    // Match fenced code block start
    if (/^```/.test(line)) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i++;
      }
      // Skip closing fence
      if (i < lines.length) i++;
      if (codeLines.length > 0) {
        results.push({
          path: currentBoldPath ?? '',
          snippet: codeLines.join('\n'),
        });
      }
      continue;
    }

    // Match inline backtick path:line reference: `some/path.ts:NN`
    const inlineRe = /`([^`:]+):(\d+)`/g;
    let m: RegExpExecArray | null;
    while ((m = inlineRe.exec(line)) !== null) {
      const path = m[1]!;
      const lineNo = parseInt(m[2]!, 10);
      if (Number.isFinite(lineNo) && lineNo >= 1) {
        results.push({ path, line: lineNo });
      }
    }

    i++;
  }

  return results;
}

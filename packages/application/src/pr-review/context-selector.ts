import type { PrReviewComment } from '@ai-sdlc/domain';
import type { PrReviewContextSnapshot } from '../ports/pr-review-context-source-port.js';
import { parseUnifiedDiff, findHunkForLine, extractBoundedSourceContext } from './unified-diff.js';

export type PrReviewContextLevel = 1 | 2 | 3;

export type SectionKind =
  | 'summary'
  | 'hunk'
  | 'source'
  | 'symbol'
  | 'test'
  | 'related-diff'
  | 'full-diff';

export interface SelectedPrReviewContextSection {
  readonly kind: SectionKind;
  readonly path?: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly content: string;
}

export interface SelectedPrReviewContext {
  readonly level: PrReviewContextLevel;
  readonly sections: readonly SelectedPrReviewContextSection[];
  readonly includedFiles: readonly string[];
  readonly includedHunks: readonly string[];
  readonly includedSymbols: readonly string[];
  readonly fullDiffIncluded: boolean;
  readonly fallbackReason?: 'explicit_global_scope' | 'no_bounded_context';
}

export interface SelectPrReviewContextInput {
  readonly comments: readonly PrReviewComment[];
  readonly attempt: PrReviewContextLevel;
  readonly snapshot: PrReviewContextSnapshot;
  readonly previousBuildErrors?: readonly string[];
  readonly previousVerifierReasons?: readonly string[];
}

const DECLARATION_PATTERN =
  /(?:(?:export\s+)?(?:abstract\s+)?class|interface|type|function|const|let|var|enum|module|namespace)\s+(\w+)|^\s*(?:async\s+)?(?!(?:if|for|while|catch|switch|return)\b)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(|^\s*(?:async\s+)?(?!(?:if|for|while|catch|switch|return)\b)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\[|<(\w+)\s*\(/m;
const TEST_FILE_PATTERN = /\.test\.ts$|\.spec\.ts$/;
const BOUNDED_CONTEXT_SIZE = 20;

function findDeclaration(
  fileContent: string,
  line: number,
): { content: string; symbol: string } | undefined {
  const lines = fileContent.split('\n');
  const beforeLine = Math.max(0, line - 1);

  for (let i = beforeLine; i >= 0; i--) {
    const lineContent = lines[i];
    if (!lineContent) continue;
    const match = lineContent.match(DECLARATION_PATTERN);
    if (match) {
      const symbol = match[1] || match[2] || match[3] || match[4];
      if (symbol) {
        return { content: lineContent, symbol };
      }
    }
  }

  for (let i = beforeLine; i < lines.length; i++) {
    const lineContent = lines[i];
    if (!lineContent) continue;
    const match = lineContent.match(DECLARATION_PATTERN);
    if (match) {
      const symbol = match[1] || match[2] || match[3] || match[4];
      if (symbol) {
        return { content: lineContent, symbol };
      }
    }
  }

  return undefined;
}

function findRelatedTests(symbol: string, trackedFiles: readonly string[]): string[] {
  const tests: string[] = [];
  const lowerSymbol = symbol.toLowerCase();

  for (const file of trackedFiles) {
    if (!TEST_FILE_PATTERN.test(file)) continue;
    if (file.toLowerCase().includes(lowerSymbol)) {
      tests.push(file);
      if (tests.length >= 2) break;
    }
  }

  return tests;
}

export function selectPrReviewContext(input: SelectPrReviewContextInput): SelectedPrReviewContext {
  const { comments, attempt, snapshot, previousBuildErrors, previousVerifierReasons } = input;

  if (comments.length === 0) {
    return {
      level: attempt,
      sections: [],
      includedFiles: [],
      includedHunks: [],
      includedSymbols: [],
      fullDiffIncluded: false,
    };
  }

  const sections: SelectedPrReviewContextSection[] = [];
  const includedFiles = new Set<string>();
  const includedHunks = new Set<string>();
  const includedSymbols = new Set<string>();

  const parsed = parseUnifiedDiff(snapshot.fullDiff);

  const summaryLines: string[] = [];
  summaryLines.push(`Diff stat: ${snapshot.diffStat}`);
  summaryLines.push(`Changed files: ${snapshot.changedFiles.join(', ')}`);

  if (previousBuildErrors && previousBuildErrors.length > 0) {
    summaryLines.push(`Previous build errors: ${previousBuildErrors.join('; ')}`);
  }
  if (previousVerifierReasons && previousVerifierReasons.length > 0) {
    summaryLines.push(`Previous verifier reasons: ${previousVerifierReasons.join('; ')}`);
  }

  sections.push({
    kind: 'summary',
    content: summaryLines.join('\n'),
  });

  const commentsByFile = new Map<string, PrReviewComment[]>();
  for (const comment of comments) {
    const list = commentsByFile.get(comment.path) ?? [];
    list.push(comment);
    commentsByFile.set(comment.path, list);
  }

  const seenHunkIdentities = new Set<string>();
  let hasBoundedContext = false;

  for (const [filePath, fileComments] of commentsByFile) {
    includedFiles.add(filePath);

    const fileContent = snapshot.fileContents[filePath];
    const parsedHunks = parsed.hunks.get(filePath);
    const seenSymbolsForFile = new Set<string>();

    for (const comment of fileComments) {
      if (parsedHunks) {
        const hunk = findHunkForLine(parsed.hunks, filePath, comment.line);
        if (hunk && !seenHunkIdentities.has(hunk.identity)) {
          seenHunkIdentities.add(hunk.identity);
          includedHunks.add(hunk.identity);
          hasBoundedContext = true;

          sections.push({
            kind: 'hunk',
            path: filePath,
            lineStart: hunk.newStart,
            lineEnd: hunk.newStart + hunk.newLines - 1,
            content: hunk.body,
          });
        }
      }

      if (fileContent) {
        const context = extractBoundedSourceContext(
          fileContent,
          comment.line,
          BOUNDED_CONTEXT_SIZE,
        );
        sections.push({
          kind: 'source',
          path: filePath,
          lineStart: Math.max(1, comment.line - BOUNDED_CONTEXT_SIZE),
          lineEnd: comment.line + BOUNDED_CONTEXT_SIZE,
          content: context,
        });
        hasBoundedContext = true;

        const declaration = findDeclaration(fileContent, comment.line);
        if (declaration && !seenSymbolsForFile.has(declaration.symbol)) {
          seenSymbolsForFile.add(declaration.symbol);
          includedSymbols.add(declaration.symbol);

          sections.push({
            kind: 'symbol',
            path: filePath,
            content: declaration.content,
          });
        }
      }

      sections.push({
        kind: 'source',
        path: filePath,
        lineStart: comment.line,
        lineEnd: comment.line,
        content: `Comment on line ${comment.line}: ${comment.body}`,
      });
    }
  }

  for (const symbol of includedSymbols) {
    const relatedTests = findRelatedTests(symbol, snapshot.trackedFiles);
    for (const testFile of relatedTests) {
      sections.push({
        kind: 'test',
        path: testFile,
        content: `Related test file: ${testFile}`,
      });
    }
  }

  if (attempt === 1) {
    return {
      level: attempt,
      sections,
      includedFiles: Array.from(includedFiles),
      includedHunks: Array.from(includedHunks),
      includedSymbols: Array.from(includedSymbols),
      fullDiffIncluded: false,
      ...(hasBoundedContext ? {} : { fallbackReason: 'no_bounded_context' as const }),
    };
  }

  if (attempt === 2) {
    for (const filePath of includedFiles) {
      const fileContent = snapshot.fileContents[filePath];
      if (fileContent) {
        sections.push({
          kind: 'source',
          path: filePath,
          content: fileContent,
        });
      }
    }

    return {
      level: attempt,
      sections,
      includedFiles: Array.from(includedFiles),
      includedHunks: Array.from(includedHunks),
      includedSymbols: Array.from(includedSymbols),
      fullDiffIncluded: false,
    };
  }

  return {
    level: attempt,
    sections,
    includedFiles: Array.from(includedFiles),
    includedHunks: Array.from(includedHunks),
    includedSymbols: Array.from(includedSymbols),
    fullDiffIncluded: true,
    fallbackReason: 'explicit_global_scope',
  };
}

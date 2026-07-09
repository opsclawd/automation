import type { ImplementStepHistoryEntry } from './types.js';

/**
 * Render an implement-step history as a single-audience (fixer) block for
 * inclusion in `buildImplementStepFixPrompt`. Defaults mirror
 * `formatReviewLoopHistoryForPrompt` (`maxEntries: 5`, `maxChars: 4000`).
 */
export function formatImplementStepHistoryForPrompt(
  history: ImplementStepHistoryEntry[],
  opts?: { maxEntries?: number; maxChars?: number },
): string {
  if (!history || history.length === 0) {
    return '';
  }
  const maxEntries = opts?.maxEntries ?? 5;
  const maxChars = opts?.maxChars ?? 4000;

  // Use newest entries, preserving chronological order.
  const sliced = history.slice(-maxEntries);

  const lines: string[] = [];
  for (const entry of sliced) {
    lines.push(`- Iteration ${entry.iteration}:`);
    if (entry.specReview.verdict) {
      lines.push(`  Spec Review: ${entry.specReview.verdict}`);
    }
    if (entry.qualityReview.verdict) {
      lines.push(`  Quality Review: ${entry.qualityReview.verdict}`);
    }
    if (entry.fix) {
      if (entry.fix.verdict) {
        lines.push(`  Fix Verdict: ${entry.fix.verdict}`);
      }
      if (entry.fix.headBeforeFix) {
        lines.push(`  Head before fix: ${entry.fix.headBeforeFix}`);
      }
      if (entry.fix.summary) {
        lines.push(`  Fix Summary: ${entry.fix.summary}`);
      }
    }
    if (entry.reverted) {
      lines.push(
        `  Reverted (build-breaking fix): ${entry.reverted.typecheckErrorCount} typecheck errors`,
      );
      lines.push(`    Restored HEAD: ${entry.reverted.headBeforeFix}`);
      const preview = entry.reverted.typecheckOutputPreview.slice(0, 240);
      if (preview.length > 0) {
        lines.push(`    Errors preview: ${preview}`);
      }
    }
    if (entry.uncommittedChanges) {
      lines.push(
        `  Uncommitted changes: ${entry.uncommittedChanges.dirtyFiles.length} dirty file(s) (claimed done_with_fixes but HEAD did not advance)`,
      );
      const preview = entry.uncommittedChanges.dirtyFiles.slice(0, 5);
      for (const file of preview) {
        lines.push(`    - ${file}`);
      }
      if (entry.uncommittedChanges.dirtyFiles.length > preview.length) {
        lines.push(
          `    ... and ${entry.uncommittedChanges.dirtyFiles.length - preview.length} more`,
        );
      }
    }
    if (entry.noCommit) {
      lines.push(
        '  No commit: claimed done_with_fixes but HEAD did not advance and worktree is clean',
      );
    }
    lines.push(`  Outcome: ${entry.outcome}`);
  }

  const header = '## Prior Fix Attempts';
  const instruction =
    'Note: Current code-review.md is primary; avoid repeating approaches already rejected.';
  const body = lines.join('\n');
  const fullText = `${header}\n\n${instruction}\n\n${body}\n`;

  if (fullText.length <= maxChars) {
    return fullText;
  }
  // Truncate at the last newline when possible.
  const sliced2 = fullText.slice(0, maxChars);
  const lastNewline = sliced2.lastIndexOf('\n');
  if (lastNewline > 0) {
    return sliced2.slice(0, lastNewline + 1);
  }
  return sliced2;
}

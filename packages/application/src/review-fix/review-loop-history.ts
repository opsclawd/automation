import type { ReviewLoopHistoryEntry, ReviewLoopHistoryAudience } from './types.js';

export function formatReviewLoopHistoryForPrompt(
  history: ReviewLoopHistoryEntry[],
  audience: ReviewLoopHistoryAudience,
  opts?: { maxEntries?: number; maxChars?: number },
): string {
  if (!history || history.length === 0) {
    return '';
  }

  const maxEntries = opts?.maxEntries ?? 5;
  const maxChars = opts?.maxChars ?? 4000;

  // Use newest entries, preserving chronological order
  const slicedHistory = history.slice(-maxEntries);

  let header = '';
  let instruction = '';

  if (audience === 'reviewer') {
    header = '## Prior Iteration History';
    instruction = 'Note: Prior loop history is context, not authority; inspect the current diff.';
  } else {
    header = '## Prior Fix Attempts';
    instruction =
      'Note: Current code-review.md is primary; avoid repeating approaches already rejected.';
  }

  const entryStrings: string[] = [];

  for (const entry of slicedHistory) {
    const lines: string[] = [];
    lines.push(`- Iteration ${entry.iteration}:`);

    if (audience === 'reviewer') {
      if (entry.review.verdict) {
        lines.push(`  Verdict: ${entry.review.verdict}`);
      }
      if (entry.review.offendingFindings && entry.review.offendingFindings.length > 0) {
        lines.push('  Offending Findings:');
        const disposition =
          entry.fix?.verdict === 'done_no_fixes_needed'
            ? 'rebutted by fixer'
            : entry.outcome === 'fixed'
              ? 'addressed by fix'
              : entry.outcome === 'resolved'
                ? 'resolved before any fix was needed'
                : 'still open';
        for (const finding of entry.review.offendingFindings) {
          lines.push(`    - [${finding.severity}] ${finding.summary}`);
          lines.push(`      Disposition: ${disposition}`);
        }
      }
      if (entry.revalidation) {
        const status = entry.revalidation.passed ? 'passed' : 'failed';
        const parts: string[] = [];
        if (entry.revalidation.category) {
          parts.push(`Category: ${entry.revalidation.category}`);
        }
        if (entry.revalidation.validationRunId) {
          parts.push(`ValidationRunId: ${entry.revalidation.validationRunId}`);
        }
        const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
        lines.push(`  Revalidation: ${status}${suffix}`);
      }
      if (entry.review.excerpt) {
        lines.push('  Excerpt:');
        lines.push(
          entry.review.excerpt
            .split('\n')
            .map((l) => `    ${l}`)
            .join('\n'),
        );
      }
      lines.push(`  Outcome: ${entry.outcome}`);
      if (entry.fix?.verdict) {
        lines.push(`  Fix Verdict: ${entry.fix.verdict}`);
      }
      if (entry.fix?.summary) {
        lines.push(`  Fix Summary: ${entry.fix.summary}`);
      }
    } else {
      // audience === 'fixer'
      if (entry.fix) {
        if (entry.fix.verdict) {
          lines.push(`  Verdict: ${entry.fix.verdict}`);
        }
        if (entry.fix.headBeforeFix) {
          lines.push(`  Head before fix: ${entry.fix.headBeforeFix}`);
        }
        if (entry.fix.summary) {
          lines.push(`  Summary: ${entry.fix.summary}`);
        }
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
      lines.push('  No commit: claimed done_with_fixes but HEAD did not advance; worktree clean');
    }

    entryStrings.push(lines.join('\n'));
  }

  const body = entryStrings.join('\n\n');
  const fullText = `${header}\n\n${instruction}\n\n${body}\n`;

  if (fullText.length <= maxChars) {
    return fullText;
  }

  // Truncate at line boundaries where possible
  const sliced = fullText.slice(0, maxChars);
  const lastNewline = sliced.lastIndexOf('\n');
  if (lastNewline > 0) {
    return sliced.slice(0, lastNewline + 1);
  }
  return sliced;
}

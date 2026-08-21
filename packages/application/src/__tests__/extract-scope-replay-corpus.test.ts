import { describe, it, expect } from 'vitest';
import { parsePathsFromMessage } from '../../../../scripts/extract-scope-replay-corpus.js';

describe('parsePathsFromMessage', () => {
  it('parses committed undeclared files', () => {
    const msg =
      'step 2 (Task 2: Implement storage provisioner core logic and lifecycle eligibility evaluator in @cco/infrastructure) committed undeclared files: packages/infrastructure/src/index.test.ts, packages/infrastructure/src/index.ts';
    const result = parsePathsFromMessage(msg);
    expect(result.parsed.map((p) => p.path)).toEqual([
      'packages/infrastructure/src/index.test.ts',
      'packages/infrastructure/src/index.ts',
    ]);
    expect(result.parsed.every((p) => p.source === 'undeclared_files')).toBe(true);
    expect(result.truncation).toEqual({ recoverable: true, truncatedCount: null });
  });

  it('parses modified reference_files (followed by continuation sentence)', () => {
    const msg =
      'step 3 (Task 3: Add failing regression tests for ReviewFixLoop protected file detection and restoration) modified reference_files packages/application/src/review-fix/review-fix-loop.ts, packages/application/src/review-fix/types.ts. This is a manifest fault: expected_files must include these files.';
    const result = parsePathsFromMessage(msg);
    expect(result.parsed.map((p) => p.path)).toEqual([
      'packages/application/src/review-fix/review-fix-loop.ts',
      'packages/application/src/review-fix/types.ts',
    ]);
    expect(result.parsed.every((p) => p.source === 'reference_files')).toBe(true);
    expect(result.truncation).toEqual({ recoverable: true, truncatedCount: null });
  });

  it('parses plan-review left the worktree dirty with trailing "... and N more." and marks truncated', () => {
    const msg =
      'plan-review left the worktree dirty: apps/web/next-env.d.ts, apps/web/next.config.ts, apps/web/package.json and 25 more. implement aborted...';
    const result = parsePathsFromMessage(msg);
    expect(result.parsed.map((p) => p.path)).toEqual([
      'apps/web/next-env.d.ts',
      'apps/web/next.config.ts',
      'apps/web/package.json',
    ]);
    expect(result.parsed.every((p) => p.source === 'worktree_dirty')).toBe(true);
    expect(result.truncation).toEqual({ recoverable: false, truncatedCount: 25 });
  });

  it('parses plan-review left the worktree dirty without truncation as recoverable', () => {
    const msg =
      'plan-review left the worktree dirty: apps/web/src/app/layout.tsx, apps/web/src/app/page.test.ts';
    const result = parsePathsFromMessage(msg);
    expect(result.parsed.map((p) => p.path)).toEqual([
      'apps/web/src/app/layout.tsx',
      'apps/web/src/app/page.test.ts',
    ]);
    expect(result.truncation).toEqual({ recoverable: true, truncatedCount: null });
  });

  it('parses file content oscillation, stripping quotes and trailing colon', () => {
    const msg =
      'File content oscillation detected for "packages/application/src/review-fix/review-fix-loop.ts": content drifted between retries';
    const result = parsePathsFromMessage(msg);
    expect(result.parsed.map((p) => p.path)).toEqual([
      'packages/application/src/review-fix/review-fix-loop.ts',
    ]);
    expect(result.parsed.every((p) => p.source === 'oscillation')).toBe(true);
  });

  it('parses PR-creation blocked by uncommitted changes with leading-dot path', () => {
    const msg = 'PR creation blocked by uncommitted source changes: .diff_output';
    const result = parsePathsFromMessage(msg);
    expect(result.parsed.map((p) => p.path)).toEqual(['.diff_output']);
    expect(result.parsed.every((p) => p.source === 'git_failed')).toBe(true);
  });

  it('returns no paths and recoverable=false for messages without parseable paths', () => {
    const msg = 'plan-review exhausted or escalated';
    const result = parsePathsFromMessage(msg);
    expect(result.parsed).toEqual([]);
    expect(result.truncation).toEqual({ recoverable: false, truncatedCount: null });
  });
});

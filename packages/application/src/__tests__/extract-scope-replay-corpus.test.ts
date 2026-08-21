import { describe, it, expect } from 'vitest';
import { parseViolatingPathsFromMessage } from '../../../../scripts/extract-scope-replay-corpus.js';

describe('parseViolatingPathsFromMessage', () => {
  it('parses committed undeclared files', () => {
    const msg =
      'step 2 (Task 2: Implement storage provisioner core logic and lifecycle eligibility evaluator in @cco/infrastructure) committed undeclared files: packages/infrastructure/src/index.test.ts, packages/infrastructure/src/index.ts';
    const paths = parseViolatingPathsFromMessage(msg);
    expect(paths).toEqual([
      'packages/infrastructure/src/index.test.ts',
      'packages/infrastructure/src/index.ts',
    ]);
  });

  it('parses modified reference_files', () => {
    const msg =
      'step 3 (Task 3: Integrate boundary classification into ImplementHandler) modified reference_files: docs/solutions/orchestrator/implement-agent-barrel-export-scope-creep-2026-08-20.md';
    const paths = parseViolatingPathsFromMessage(msg);
    expect(paths).toEqual([
      'docs/solutions/orchestrator/implement-agent-barrel-export-scope-creep-2026-08-20.md',
    ]);
  });

  it('parses plan-review left the worktree dirty with trailing "... and N more."', () => {
    const msg =
      'plan-review left the worktree dirty: apps/web/next-env.d.ts, apps/web/next.config.ts, apps/web/package.json and 25 more.';
    const paths = parseViolatingPathsFromMessage(msg);
    expect(paths).toEqual([
      'apps/web/next-env.d.ts',
      'apps/web/next.config.ts',
      'apps/web/package.json',
    ]);
  });
});

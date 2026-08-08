import { describe, expect, it } from 'vitest';
import { classifyPostFixGateFailure } from '../post-fix-gate-classification.js';

// Verbatim from run 5b57a291 (clmm-v2#157), whose errors did not reproduce on
// the branch or on main. See automation#878.
const DRIFT_OUTPUT = [
  'Scope: 7 of 8 workspace projects',
  "packages/domain typecheck: src/execution/ExecutionPlanFactory.test.ts(1,38): error TS2307: Cannot find module 'vitest' or its corresponding type declarations.",
  'packages/domain typecheck: src/positions/enrichment.test.ts(15,26): error TS2737: BigInt literals are not available when targeting lower than ES2020.',
  "packages/domain typecheck: src/positions/enrichment.test.ts(71,26): error TS2583: Cannot find name 'BigInt'. Do you need to change your target library?",
].join('\n');

describe('classifyPostFixGateFailure', () => {
  it('classifies drift diagnostics for a package the fixer never touched', () => {
    const result = classifyPostFixGateFailure({
      output: DRIFT_OUTPUT,
      changedFiles: ['apps/api/src/compose.ts'],
    });

    expect(result.classification).toBe('workspace_inconsistency');
    if (result.classification === 'workspace_inconsistency') {
      expect(result.reportingPackage).toBe('packages/domain');
      expect(result.diagnostic).toContain('TS2307');
    }
  });

  it('stays a code defect when the fixer changed the reporting package', () => {
    expect(
      classifyPostFixGateFailure({
        output: DRIFT_OUTPUT,
        changedFiles: ['packages/domain/src/positions/enrichment.ts'],
      }).classification,
    ).toBe('code_defect');
  });

  it('stays a code defect for an empty delta', () => {
    // The fixer changed nothing, so a still-red gate is the same failure as
    // before — not evidence the workspace drifted. Fail closed.
    expect(
      classifyPostFixGateFailure({ output: DRIFT_OUTPUT, changedFiles: [] }).classification,
    ).toBe('code_defect');
  });

  it('stays a code defect when the delta cannot be determined', () => {
    expect(
      classifyPostFixGateFailure({ output: DRIFT_OUTPUT, changedFiles: undefined }).classification,
    ).toBe('code_defect');
  });

  it('stays a code defect when a root workspace-control file changed', () => {
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json']) {
      expect(
        classifyPostFixGateFailure({ output: DRIFT_OUTPUT, changedFiles: [file] }).classification,
      ).toBe('code_defect');
    }
  });

  it('stays a code defect for ordinary compile errors', () => {
    expect(
      classifyPostFixGateFailure({
        output:
          "packages/domain typecheck: src/a.ts(3,1): error TS2345: Argument of type 'string' is not assignable.",
        changedFiles: ['apps/api/src/compose.ts'],
      }).classification,
    ).toBe('code_defect');
  });

  it('stays a code defect when a drift signature carries no reporting package', () => {
    expect(
      classifyPostFixGateFailure({
        output: "src/x.test.ts(1,1): error TS2307: Cannot find module 'vitest'.",
        changedFiles: ['apps/api/src/compose.ts'],
      }).classification,
    ).toBe('code_defect');
  });

  it('normalises backslash paths when attributing to the reporting package', () => {
    expect(
      classifyPostFixGateFailure({
        output: DRIFT_OUTPUT,
        changedFiles: ['packages\\domain\\src\\positions\\enrichment.ts'],
      }).classification,
    ).toBe('code_defect');
  });
});

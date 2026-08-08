/**
 * Classify a failing post-fix gate as either a defect in the diff under review
 * or transient workspace inconsistency.
 *
 * Motivation (automation#878): run 5b57a291 failed the review-fix loop on
 * `packages/domain` typecheck errors that did not reproduce on the branch or on
 * main. A missing `vitest` module declaration together with BigInt/ES2020
 * target errors is the signature of a package resolving against node_modules or
 * tsconfig that do not match its source tree — not of broken code. The loop
 * consumed its iterations on that and failed a run whose output was correct and
 * later shipped as clmm-v2#158.
 *
 * This module only classifies. It performs no recovery and has no side effects.
 */

export type PostFixGateFailureClassification =
  | { classification: 'code_defect' }
  | {
      classification: 'workspace_inconsistency';
      diagnostic: string;
      reportingPackage: string;
    };

export interface ClassifyPostFixGateFailureInput {
  /** Combined gate output (stdout/stderr) for the failing run. */
  output: string;
  /**
   * Paths the previous fixer changed, repository-relative. `undefined` means the
   * delta could not be determined.
   */
  changedFiles: string[] | undefined;
}

/**
 * Diagnostics that indicate the toolchain, not the source, is wrong. Kept
 * deliberately narrow: only signatures actually observed in run 5b57a291.
 * Anything unrecognised stays `code_defect`.
 */
const WORKSPACE_DRIFT_SIGNATURES: ReadonlyArray<RegExp> = [
  /error TS2307:\s*Cannot find module 'vitest'/,
  /error TS2737:\s*BigInt literals are not available when targeting lower than ES2020/,
  /error TS2583:\s*Cannot find name 'BigInt'/,
];

/**
 * Changing any of these can legitimately produce workspace-wide diagnostics, so
 * a failure is attributable to the diff rather than to drift.
 */
const ROOT_WORKSPACE_CONTROL_FILES: ReadonlyArray<RegExp> = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^tsconfig(\.[^/]+)?\.json$/,
];

function normalise(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

/**
 * Turbo prefixes diagnostics with the workspace project, e.g.
 * `packages/domain typecheck: src/foo.test.ts(1,1): error TS2307: ...`.
 */
function reportingPackageFor(line: string): string | undefined {
  const match = /(^|\s)((?:packages|apps)\/[A-Za-z0-9._-]+)\b/.exec(line);
  return match?.[2];
}

export function classifyPostFixGateFailure(
  input: ClassifyPostFixGateFailureInput,
): PostFixGateFailureClassification {
  const { output, changedFiles } = input;

  // An undetermined delta is not evidence of drift — fail closed.
  if (changedFiles === undefined) return { classification: 'code_defect' };

  const changed = changedFiles.map(normalise).filter(Boolean);

  // An empty delta is likewise not evidence of drift. The fixer changed
  // nothing, so a still-red gate is the same failure as before, unattributed.
  // Treating "changed nothing" as "therefore environmental" would let a fixer
  // that does nothing repeatedly excuse a genuine failure.
  if (changed.length === 0) return { classification: 'code_defect' };

  if (changed.some((path) => ROOT_WORKSPACE_CONTROL_FILES.some((re) => re.test(path)))) {
    return { classification: 'code_defect' };
  }

  for (const line of output.split('\n')) {
    if (!WORKSPACE_DRIFT_SIGNATURES.some((re) => re.test(line))) continue;

    const reportingPackage = reportingPackageFor(line);
    if (!reportingPackage) continue;

    // Attributable if the fixer touched the package that is complaining.
    const touchedReportingPackage = changed.some(
      (path) => path === reportingPackage || path.startsWith(`${reportingPackage}/`),
    );
    if (touchedReportingPackage) continue;

    return {
      classification: 'workspace_inconsistency',
      diagnostic: line.trim(),
      reportingPackage,
    };
  }

  return { classification: 'code_defect' };
}

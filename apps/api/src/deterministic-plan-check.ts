import type { PlanReviewContext } from '@ai-sdlc/application';
import type { SignatureReferenceAnalyzerPort } from '@ai-sdlc/application';
import type { TaskManifest } from '@ai-sdlc/application';
import {
  collectDeclaredSignatureChanges,
  evaluateSignatureBlastRadius,
  renderSignatureBlastRadiusDiagnostic,
  type SignatureBlastRadiusFailure,
} from '@ai-sdlc/application';
import {
  parseTaskManifest,
  validatePlanTaskList,
  checkTaskValidationCommandsSatisfiability,
} from '@ai-sdlc/application';

export interface DeterministicPlanCheckResult {
  diagnostic: string | null;
  signatureBlastRadiusFailures: SignatureBlastRadiusFailure[];
}

export interface CreateDeterministicPlanCheckOptions {
  readPlanMd: (ctx: PlanReviewContext) => Promise<string>;
  readManifest: (ctx: PlanReviewContext) => Promise<string | null>;
  validatePlanTaskList: typeof validatePlanTaskList;
  signatureAnalyzer: SignatureReferenceAnalyzerPort;
  forbiddenArtifactPaths?: readonly string[] | undefined;
}

function normalizePath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/|\/)+/, '')
    .replace(/\/+$/, '');
}

function isForbiddenPath(
  candidatePath: string,
  normalizedForbiddenPrefixes: readonly string[],
): boolean {
  for (const prefix of normalizedForbiddenPrefixes) {
    if (!prefix) continue;
    if (candidatePath === prefix || candidatePath.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

function joinDiagnostics(...diagnostics: Array<string | null | undefined>): string | null {
  const parts = diagnostics.filter((d): d is string => Boolean(d && d.trim().length > 0));
  if (parts.length === 0) return null;
  return parts.join('\n\n');
}

export function createDeterministicPlanCheck(options: CreateDeterministicPlanCheckOptions) {
  const {
    readPlanMd,
    readManifest,
    validatePlanTaskList: validate,
    signatureAnalyzer,
    forbiddenArtifactPaths,
  } = options;

  const normalizedForbiddenPrefixes = (forbiddenArtifactPaths ?? [])
    .map(normalizePath)
    .filter((p) => p.length > 0);

  return async function checkDeterministicPlan(
    ctx: PlanReviewContext,
  ): Promise<DeterministicPlanCheckResult> {
    let planMd: string;
    try {
      planMd = await readPlanMd(ctx);
    } catch {
      return { diagnostic: null, signatureBlastRadiusFailures: [] };
    }

    let manifestJson: string | null;
    try {
      manifestJson = await readManifest(ctx);
    } catch {
      manifestJson = null;
    }

    if (manifestJson === null) {
      return { diagnostic: null, signatureBlastRadiusFailures: [] };
    }

    const manifestResult = parseTaskManifest(manifestJson);
    if (!manifestResult.success) {
      const diagnostic = `task-manifest.json parse failure: ${manifestResult.error}`;
      return { diagnostic, signatureBlastRadiusFailures: [] };
    }

    const manifest: TaskManifest = manifestResult.manifest;
    const structuralResult = validate(planMd, manifestJson);
    const structuralDiagnostic = structuralResult.success ? null : structuralResult.error;

    let forbiddenArtifactDiagnostic: string | null = null;
    if (normalizedForbiddenPrefixes.length > 0) {
      const violationMap = new Map<string, { taskNumber: number; path: string }>();
      for (const task of manifest.tasks) {
        const taskRecord = task as {
          expected_files?: string[] | null;
          files?: string[] | null;
        };
        const declared = [...(taskRecord.expected_files ?? []), ...(taskRecord.files ?? [])];
        for (const item of declared) {
          const norm = normalizePath(item);
          if (!norm) continue;
          if (isForbiddenPath(norm, normalizedForbiddenPrefixes)) {
            const key = `${task.n}:${norm}`;
            if (!violationMap.has(key)) {
              violationMap.set(key, { taskNumber: task.n, path: norm });
            }
          }
        }
      }
      if (violationMap.size > 0) {
        const sortedViolations = Array.from(violationMap.values()).sort((a, b) => {
          if (a.taskNumber !== b.taskNumber) return a.taskNumber - b.taskNumber;
          return a.path.localeCompare(b.path);
        });
        forbiddenArtifactDiagnostic = sortedViolations
          .map(
            (v) =>
              `Task ${v.taskNumber} declares an expected output that is a capture of external physical state (forbidden path: ${v.path}). You must split the work into a harness build step and an execution step performed outside the run.`,
          )
          .join('\n\n');
      }
    }

    const declaredChanges = collectDeclaredSignatureChanges(manifest);
    let blastRadiusFailures: SignatureBlastRadiusFailure[] = [];

    if (declaredChanges.length > 0) {
      const analyses = await signatureAnalyzer.analyze({
        worktreeRoot: ctx.cwd,
        changes: declaredChanges,
      });
      const blastRadiusResult = evaluateSignatureBlastRadius(manifest, analyses);
      blastRadiusFailures = blastRadiusResult.failures;
    }

    const blastRadiusDiagnostic = renderSignatureBlastRadiusDiagnostic(blastRadiusFailures);

    const validationCommandDiagnostic = await checkTaskValidationCommandsSatisfiability(
      manifest,
      { worktreeRoot: ctx.cwd },
    );

    const diagnostic = joinDiagnostics(
      structuralDiagnostic,
      forbiddenArtifactDiagnostic,
      blastRadiusDiagnostic,
      validationCommandDiagnostic,
    );

    return { diagnostic, signatureBlastRadiusFailures: blastRadiusFailures };
  };
}

export type CheckDeterministicPlanFn = (
  ctx: PlanReviewContext,
) => Promise<DeterministicPlanCheckResult>;

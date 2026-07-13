import type { PlanReviewContext } from '@ai-sdlc/application';
import type { SignatureReferenceAnalyzerPort } from '@ai-sdlc/application';
import type { TaskManifest } from '@ai-sdlc/application';
import {
  collectDeclaredSignatureChanges,
  evaluateSignatureBlastRadius,
  renderSignatureBlastRadiusDiagnostic,
  type SignatureBlastRadiusFailure,
} from '@ai-sdlc/application';
import { parseTaskManifest, validatePlanTaskList } from '@ai-sdlc/application';

export interface DeterministicPlanCheckResult {
  diagnostic: string | null;
  signatureBlastRadiusFailures: SignatureBlastRadiusFailure[];
}

export interface CreateDeterministicPlanCheckOptions {
  readPlanMd: (ctx: PlanReviewContext) => Promise<string>;
  readManifest: (ctx: PlanReviewContext) => Promise<string | null>;
  validatePlanTaskList: typeof validatePlanTaskList;
  signatureAnalyzer: SignatureReferenceAnalyzerPort;
}

function joinDiagnostics(
  structuralDiagnostic: string | null,
  blastRadiusDiagnostic: string | null,
): string | null {
  if (!structuralDiagnostic && !blastRadiusDiagnostic) return null;
  if (!structuralDiagnostic) return blastRadiusDiagnostic;
  if (!blastRadiusDiagnostic) return structuralDiagnostic;
  return `${structuralDiagnostic}\n\n${blastRadiusDiagnostic}`;
}

export function createDeterministicPlanCheck(options: CreateDeterministicPlanCheckOptions) {
  const { readPlanMd, readManifest, validatePlanTaskList: validate, signatureAnalyzer } = options;

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
    const diagnostic = joinDiagnostics(structuralDiagnostic, blastRadiusDiagnostic);

    return { diagnostic, signatureBlastRadiusFailures: blastRadiusFailures };
  };
}

export type CheckDeterministicPlanFn = (
  ctx: PlanReviewContext,
) => Promise<DeterministicPlanCheckResult>;

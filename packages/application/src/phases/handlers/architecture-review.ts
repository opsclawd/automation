import { PhaseName, AgentProfileName, type Failure, type FailureKind } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { ArtifactNotFoundError } from '../../ports/artifact-store.js';
import { runSingleShotAgentPhase } from './run-single-shot-agent-phase.js';
import { loadPromptTemplate } from '../../prompts/load-prompt-template.js';
import {
  architectureReviewResultSchema,
  isApprovedArchitectureReview,
  type ArchitectureReviewResult,
} from '../../results/schemas/architecture-review.js';
import { plannerPackageSchema } from '../../results/schemas/planner-package.js';
import { validatePlanTaskList } from '../plan-tasks.js';

export interface ArchitectureReviewHandlerOpts {
  profileName?: string;
  maxCorrections?: number;
}

export class ArchitectureReviewHandler implements PhaseHandler {
  readonly phase = PhaseName('architecture-review');
  readonly maxCorrections: number;

  constructor(private readonly opts: ArchitectureReviewHandlerOpts = {}) {
    this.maxCorrections = opts.maxCorrections ?? 2;
  }

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);

    if (ctx.executionPolicy !== 'strict') {
      emit(
        'architecture_review.skipped',
        'info',
        'architecture-review skipped under non-strict policy',
        {
          policy: ctx.executionPolicy,
        },
      );
      return { outcome: 'passed' };
    }

    emit('architecture_review.started', 'info', 'independent architecture review started', {
      policy: ctx.executionPolicy,
    });

    // 1. Resume / idempotency check: reuse approved review if already present
    try {
      const existingRaw = await ctx.artifacts.read(ctx.runUuid, 'architecture-review.json');
      if (existingRaw.trim().length > 0) {
        const parsedObj = JSON.parse(existingRaw);
        const parseResult = architectureReviewResultSchema.safeParse(parsedObj);
        if (parseResult.success && isApprovedArchitectureReview(parseResult.data)) {
          emit(
            'architecture_review.completed',
            'info',
            'architecture review already approved (reusing existing review)',
            { policy: ctx.executionPolicy },
          );
          return { outcome: 'passed' };
        }
      }
    } catch {
      // Artifact not present or invalid, proceed with review
    }

    // 2. Validate required inputs: issue.md, design.md, and plan.md
    try {
      await ctx.artifacts.read(ctx.runUuid, 'issue.md');
      await ctx.artifacts.read(ctx.runUuid, 'design.md');
      await ctx.artifacts.read(ctx.runUuid, 'plan.md');
    } catch (e) {
      const message =
        e instanceof ArtifactNotFoundError
          ? 'issue.md, design.md, or plan.md not found in artifact store'
          : `Failed to read planning artifacts: ${e instanceof Error ? e.message : String(e)}`;
      return this.fail(ctx, emit, 'missing_artifact', message);
    }

    // 3. Resolve reviewer profile (independent critic/reviewer)
    const reviewerProfile =
      ctx.resolveProfile?.('architecture-review') ??
      ctx.resolveProfile?.('pr-reviewer') ??
      ctx.resolveProfile?.('critic') ??
      AgentProfileName(this.opts.profileName ?? 'gemini');

    // 4. Load reviewer prompt template
    let reviewTemplate: string | undefined;
    if (ctx.promptsRoot) {
      try {
        reviewTemplate = loadPromptTemplate('architecture-review', 'architecture-review', {
          promptsRoot: ctx.promptsRoot,
        });
      } catch {
        // Handled in runSingleShotAgentPhase
      }
    }

    // 5. Reviewer Invocation (Pass 1)
    const reviewResult = await runSingleShotAgentPhase(ctx, {
      phase: 'architecture-review',
      profile: reviewerProfile,
      step: 'architecture-review',
      ...(reviewTemplate ? { template: reviewTemplate } : {}),
      vars: {
        issue_number: String(ctx.issueNumber),
        cwd: ctx.cwd,
      },
      agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
      skipCompletedEmit: true,
    });

    if (reviewResult.outcome !== 'passed') {
      emit('architecture_review.failed', 'error', 'architecture reviewer agent failed');
      return reviewResult;
    }

    const reviewData: ArchitectureReviewResult = reviewResult.result;

    const isApproved = isApprovedArchitectureReview(reviewData);
    const blockingFindings = this.getBlockingFindings(reviewData);
    const failedReqs = this.getFailedRequirementChecks(reviewData);

    if (isApproved) {
      await this.persistReviewArtifacts(ctx, emit, reviewData);
      emit(
        'architecture_review.completed',
        'info',
        'architecture review approved on initial evaluation',
        {
          policy: ctx.executionPolicy,
        },
      );
      return { outcome: 'passed' };
    }

    // 7. Findings identified -> Targeted Planner Correction Pass(es)
    await this.persistReviewArtifacts(ctx, emit, reviewData);

    if (this.maxCorrections === 0) {
      const totalGapsCount = blockingFindings.length + failedReqs.length;
      const failureSummary = `Architecture review identified ${totalGapsCount} blocking gap(s) (${blockingFindings.length} finding(s), ${failedReqs.length} failed requirement(s)) and maxCorrections is 0`;
      emit('architecture_review.exhausted', 'warn', failureSummary, {
        policy: ctx.executionPolicy,
        maxCorrections: 0,
        blockingFindingsCount: blockingFindings.length,
        failedRequirementsCount: failedReqs.length,
      });
      return this.needsHumanReview(ctx, emit, failureSummary, [
        'architecture-review.json',
        'design.md',
        'plan.md',
      ]);
    }

    let currentReviewData = reviewData;
    let currentBlockingFindings = blockingFindings;
    let currentFailedReqs = failedReqs;

    for (let correction = 1; correction <= this.maxCorrections; correction++) {
      const totalGapsCount = currentBlockingFindings.length + currentFailedReqs.length;
      emit(
        'architecture_review.findings_found',
        'warn',
        `architecture review identified ${totalGapsCount} blocking gap(s) (${currentBlockingFindings.length} finding(s), ${currentFailedReqs.length} failed requirement(s)); invoking targeted planner correction (attempt ${correction}/${this.maxCorrections})`,
        {
          policy: ctx.executionPolicy,
          correctionAttempt: correction,
          maxCorrections: this.maxCorrections,
          blockingFindingsCount: currentBlockingFindings.length,
          failedRequirementsCount: currentFailedReqs.length,
        },
      );

      const formattedFindings = this.formatFindingsForPrompt(
        currentReviewData,
        currentBlockingFindings,
        currentFailedReqs,
      );

      const plannerProfile =
        ctx.resolveProfile?.('architecture-fix') ??
        ctx.resolveProfile?.('plan-design') ??
        ctx.resolveProfile?.('planner') ??
        AgentProfileName('architect');

      let fixTemplate: string | undefined;
      if (ctx.promptsRoot) {
        try {
          fixTemplate = loadPromptTemplate('architecture-review', 'architecture-fix', {
            promptsRoot: ctx.promptsRoot,
          });
        } catch {
          // Fallback handled in runSingleShotAgentPhase
        }
      }

      const fixResult = await runSingleShotAgentPhase(ctx, {
        phase: this.phase,
        profile: plannerProfile,
        step: 'architecture-fix',
        ...(fixTemplate ? { template: fixTemplate } : {}),
        vars: {
          issue_number: String(ctx.issueNumber),
          cwd: ctx.cwd,
          review_findings: formattedFindings,
        },
        agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
        resultMeta: {
          schema: plannerPackageSchema,
          schemaContractText:
            '{\n  "design_md": string,\n  "plan_md": string,\n  "summary"?: string,\n  "result"?: "ready" | "blocked"\n}',
        },
        skipCompletedEmit: true,
      });

      if (fixResult.outcome !== 'passed') {
        emit(
          'architecture_review.fix_failed',
          'error',
          `targeted planner correction invocation failed on attempt ${correction}/${this.maxCorrections}`,
        );
        return this.needsHumanReview(
          ctx,
          emit,
          `Targeted planner correction failed to execute during architecture review (attempt ${correction}/${this.maxCorrections})`,
          ['architecture-review.json', 'design.md', 'plan.md'],
        );
      }

      const { design_md: correctedDesignMd, plan_md: correctedPlanMd } = fixResult.result;

      // Deterministic validation on corrected plan
      const planValidation = validatePlanTaskList(
        correctedPlanMd,
        undefined,
        ctx,
        'architecture-review',
      );
      if (!planValidation.success) {
        return this.needsHumanReview(
          ctx,
          emit,
          `Deterministic plan check failed on corrected plan (attempt ${correction}/${this.maxCorrections}): ${planValidation.error}`,
          ['architecture-review.json', 'plan.md'],
        );
      }

      // Persist authoritative corrected artifacts
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'design.md',
        contents: correctedDesignMd,
      });
      emit('artifact.created', 'info', 'artifact updated: design.md', {
        relativePath: 'design.md',
      });

      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'plan.md',
        contents: correctedPlanMd,
      });
      emit('artifact.created', 'info', 'artifact updated: plan.md', { relativePath: 'plan.md' });

      // Verification Pass
      emit(
        'architecture_review.verification_started',
        'info',
        `running architecture re-verification pass on corrected artifacts (attempt ${correction}/${this.maxCorrections})`,
        {
          policy: ctx.executionPolicy,
          correctionAttempt: correction,
          maxCorrections: this.maxCorrections,
        },
      );

      const revalResult = await runSingleShotAgentPhase(ctx, {
        phase: 'architecture-review',
        profile: reviewerProfile,
        step: 'architecture-verify',
        ...(reviewTemplate ? { template: reviewTemplate } : {}),
        vars: {
          issue_number: String(ctx.issueNumber),
          cwd: ctx.cwd,
        },
        agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
        skipCompletedEmit: true,
      });

      if (revalResult.outcome !== 'passed') {
        return this.needsHumanReview(
          ctx,
          emit,
          `Architecture re-verification agent invocation failed on attempt ${correction}/${this.maxCorrections}`,
          ['architecture-review.json', 'design.md', 'plan.md'],
        );
      }

      const revalData: ArchitectureReviewResult = revalResult.result;

      await this.persistReviewArtifacts(ctx, emit, revalData);

      const isRevalApproved = isApprovedArchitectureReview(revalData);
      if (isRevalApproved) {
        emit(
          'architecture_review.completed',
          'info',
          `architecture review approved after targeted correction and verification (attempt ${correction}/${this.maxCorrections})`,
          {
            policy: ctx.executionPolicy,
            correctionAttempt: correction,
            maxCorrections: this.maxCorrections,
          },
        );
        return { outcome: 'passed' };
      }

      // Update state for next correction iteration
      currentReviewData = revalData;
      currentBlockingFindings = this.getBlockingFindings(revalData);
      currentFailedReqs = this.getFailedRequirementChecks(revalData);
    }

    // Budget exhausted -> Escalate to human review
    const remainingGapsCount = currentBlockingFindings.length + currentFailedReqs.length;
    const failureSummary = `Architecture review did not converge within fixed budget: ${remainingGapsCount} blocking gap(s) remain after ${this.maxCorrections} correction attempt(s) (${currentBlockingFindings.length} finding(s), ${currentFailedReqs.length} failed requirement(s))`;
    emit('architecture_review.exhausted', 'warn', failureSummary, {
      policy: ctx.executionPolicy,
      maxCorrections: this.maxCorrections,
      remainingFindingsCount: currentBlockingFindings.length,
      remainingFailedRequirementsCount: currentFailedReqs.length,
    });

    return this.needsHumanReview(ctx, emit, failureSummary, [
      'architecture-review.json',
      'design.md',
      'plan.md',
    ]);
  }

  private getFailedRequirementChecks(result: ArchitectureReviewResult) {
    return (result.requirements_checks ?? []).filter((c) => c.result.toUpperCase() === 'FAIL');
  }

  private getBlockingFindings(result: ArchitectureReviewResult) {
    const isExplicitlyApproved = isApprovedArchitectureReview(result);
    return result.findings.filter((f) => {
      if (f.blocking === true) return true;
      if (['critical', 'high', 'P0', 'P1'].includes(f.severity)) return true;
      if (!isExplicitlyApproved) return true;
      return false;
    });
  }

  private formatFindingsForPrompt(
    result: ArchitectureReviewResult,
    blockingFindings: ArchitectureReviewResult['findings'],
    failedReqs: ArchitectureReviewResult['requirements_checks'],
  ): string {
    const lines: string[] = [];
    if (result.summary) {
      lines.push(`### Review Summary\n${result.summary}\n`);
    }

    if (failedReqs && failedReqs.length > 0) {
      lines.push('### Failed Requirements Checks:');
      for (const check of failedReqs) {
        lines.push(`- [FAIL] ${check.requirement}: ${check.evidence ?? 'No evidence provided'}`);
      }
      lines.push('');
    }

    if (blockingFindings.length > 0) {
      lines.push('### Blocking Architectural Findings:');
      for (const [idx, finding] of blockingFindings.entries()) {
        lines.push(
          `#### Finding ${idx + 1} [${finding.severity.toUpperCase()}] (${finding.category ?? 'general'})`,
        );
        if (finding.target) lines.push(`- **Target:** ${finding.target}`);
        lines.push(`- **Evidence:** ${finding.evidence}`);
        lines.push(`- **Rationale:** ${finding.rationale}`);
        lines.push(`- **Minimal Correction:** ${finding.minimal_correction}`);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  private async persistReviewArtifacts(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
    reviewData: ArchitectureReviewResult,
  ): Promise<void> {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: this.phase,
      relativePath: 'architecture-review.json',
      contents: JSON.stringify(reviewData, null, 2),
    });
    emit('artifact.created', 'info', 'artifact created: architecture-review.json', {
      relativePath: 'architecture-review.json',
    });

    if (reviewData.review_md) {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'architecture-review.md',
        contents: reviewData.review_md,
      });
      emit('artifact.created', 'info', 'artifact created: architecture-review.md', {
        relativePath: 'architecture-review.md',
      });
    }
  }

  private fail(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
    kind: FailureKind,
    message: string,
  ): PhaseResult {
    const failure: Failure = {
      runUuid: ctx.runUuid,
      phase: this.phase as string,
      kind,
      message,
      canRetry: true,
      suggestedAction: 'Inspect planning artifacts and retry.',
      artifacts: [],
      detectedAt: ctx.now(),
    };
    emit('architecture_review.failed', 'error', message);
    return { outcome: 'failed', failure };
  }

  private needsHumanReview(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
    message: string,
    artifacts: string[],
  ): PhaseResult {
    const failure: Failure = {
      runUuid: ctx.runUuid,
      phase: this.phase as string,
      kind: 'needs_human_review',
      message,
      canRetry: true,
      suggestedAction: 'Inspect architecture review findings and resolve blocking gaps manually.',
      artifacts,
      detectedAt: ctx.now(),
    };
    emit('architecture_review.needs_human_review', 'warn', message);
    return { outcome: 'needs_human_review', failure };
  }
}

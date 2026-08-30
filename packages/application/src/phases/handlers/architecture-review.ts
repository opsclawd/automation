import { PhaseName, AgentProfileName, type Failure, type FailureKind } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { ArtifactNotFoundError } from '../../ports/artifact-store.js';
import { runSingleShotAgentPhase } from './run-single-shot-agent-phase.js';
import { loadPromptTemplate } from '../../prompts/load-prompt-template.js';
import {
  architectureReviewResultSchema,
  type ArchitectureReviewResult,
} from '../../results/schemas/architecture-review.js';
import { plannerPackageSchema } from '../../results/schemas/planner-package.js';
import { validatePlanTaskList } from '../plan-tasks.js';

export interface ArchitectureReviewHandlerOpts {
  profileName?: string;
}

export class ArchitectureReviewHandler implements PhaseHandler {
  readonly phase = PhaseName('architecture-review');

  constructor(private readonly opts: ArchitectureReviewHandlerOpts = {}) {}

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
        const parsed = JSON.parse(existingRaw) as { verdict?: string };
        const verdict = parsed.verdict?.toUpperCase();
        if (verdict === 'APPROVE' || verdict === 'PASS') {
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
      // Artifact not present, proceed with review
    }

    // 2. Validate required inputs: design.md and plan.md
    try {
      await ctx.artifacts.read(ctx.runUuid, 'design.md');
      await ctx.artifacts.read(ctx.runUuid, 'plan.md');
    } catch (e) {
      const message =
        e instanceof ArtifactNotFoundError
          ? 'design.md or plan.md not found in artifact store'
          : `Failed to read planning artifacts: ${e instanceof Error ? e.message : String(e)}`;
      return this.fail(ctx, emit, 'missing_artifact', message);
    }

    // 3. Resolve reviewer profile
    const reviewerProfile =
      ctx.resolveProfile?.('architecture-review') ??
      ctx.resolveProfile?.('plan-review') ??
      ctx.resolveProfile?.('plan-design') ??
      AgentProfileName(this.opts.profileName ?? 'opencode-frontier');

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
      phase: this.phase,
      profile: reviewerProfile,
      step: 'architecture-review',
      ...(reviewTemplate ? { template: reviewTemplate } : {}),
      vars: {
        issue_number: String(ctx.issueNumber),
        cwd: ctx.cwd,
      },
      agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
      skipResultExtraction: true,
    });

    if (reviewResult.outcome !== 'passed') {
      emit('architecture_review.failed', 'error', 'architecture reviewer agent failed');
      return reviewResult;
    }

    // 6. Extract and validate structured review verdict
    let reviewData: ArchitectureReviewResult;
    try {
      const rawJson = await ctx.artifacts.read(ctx.runUuid, 'result.json');
      const parsedObj = JSON.parse(rawJson);
      const parseResult = architectureReviewResultSchema.safeParse(parsedObj);
      if (!parseResult.success) {
        return this.fail(
          ctx,
          emit,
          'invalid_result',
          `Architecture review result schema validation failed: ${parseResult.error.message}`,
        );
      }
      reviewData = parseResult.data;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return this.fail(
        ctx,
        emit,
        'invalid_result',
        `Failed to read or parse architecture review result: ${message}`,
      );
    }

    const isApproved = this.isVerdictApproved(reviewData);
    const blockingFindings = this.getBlockingFindings(reviewData);

    if (isApproved && blockingFindings.length === 0) {
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

    // 7. Findings identified -> Targeted Planner Correction Pass (Pass 2)
    await this.persistReviewArtifacts(ctx, emit, reviewData);
    emit(
      'architecture_review.findings_found',
      'warn',
      `architecture review identified ${blockingFindings.length} blocking finding(s); invoking targeted planner correction`,
      { policy: ctx.executionPolicy, blockingFindingsCount: blockingFindings.length },
    );

    const formattedFindings = this.formatFindingsForPrompt(reviewData, blockingFindings);

    const plannerProfile =
      ctx.resolveProfile?.('plan-design') ??
      ctx.resolveProfile?.('architecture-review') ??
      AgentProfileName('opencode-frontier');

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
      skipResultExtraction: true,
    });

    if (fixResult.outcome !== 'passed') {
      emit(
        'architecture_review.fix_failed',
        'error',
        'targeted planner correction invocation failed',
      );
      return this.needsHumanReview(
        ctx,
        emit,
        'Targeted planner correction failed to execute during architecture review',
        ['architecture-review.json', 'design.md', 'plan.md'],
      );
    }

    // Parse and validate corrected planner package
    let correctedDesignMd: string;
    let correctedPlanMd: string;
    try {
      const rawFixJson = await ctx.artifacts.read(ctx.runUuid, 'result.json');
      const parsedFixObj = JSON.parse(rawFixJson);
      const fixParseResult = plannerPackageSchema.safeParse(parsedFixObj);
      if (!fixParseResult.success) {
        return this.needsHumanReview(
          ctx,
          emit,
          `Corrected planner package schema validation failed: ${fixParseResult.error.message}`,
          ['architecture-review.json', 'result.json'],
        );
      }
      correctedDesignMd = fixParseResult.data.design_md;
      correctedPlanMd = fixParseResult.data.plan_md;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return this.needsHumanReview(
        ctx,
        emit,
        `Failed to parse corrected planner package from architecture-fix: ${message}`,
        ['architecture-review.json'],
      );
    }

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
        `Deterministic plan check failed on corrected plan: ${planValidation.error}`,
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
    emit('artifact.created', 'info', 'artifact updated: design.md', { relativePath: 'design.md' });

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: this.phase,
      relativePath: 'plan.md',
      contents: correctedPlanMd,
    });
    emit('artifact.created', 'info', 'artifact updated: plan.md', { relativePath: 'plan.md' });

    // 8. Single Verification Pass (Pass 3)
    emit(
      'architecture_review.verification_started',
      'info',
      'running architecture re-verification pass on corrected artifacts',
      { policy: ctx.executionPolicy },
    );

    const revalResult = await runSingleShotAgentPhase(ctx, {
      phase: this.phase,
      profile: reviewerProfile,
      step: 'architecture-verify',
      ...(reviewTemplate ? { template: reviewTemplate } : {}),
      vars: {
        issue_number: String(ctx.issueNumber),
        cwd: ctx.cwd,
      },
      agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
      skipResultExtraction: true,
    });

    if (revalResult.outcome !== 'passed') {
      return this.needsHumanReview(
        ctx,
        emit,
        'Architecture re-verification agent invocation failed',
        ['architecture-review.json', 'design.md', 'plan.md'],
      );
    }

    let revalData: ArchitectureReviewResult;
    try {
      const rawRevalJson = await ctx.artifacts.read(ctx.runUuid, 'result.json');
      const parsedRevalObj = JSON.parse(rawRevalJson);
      const parseResult = architectureReviewResultSchema.safeParse(parsedRevalObj);
      if (!parseResult.success) {
        return this.needsHumanReview(
          ctx,
          emit,
          `Architecture re-verification result schema validation failed: ${parseResult.error.message}`,
          ['architecture-review.json'],
        );
      }
      revalData = parseResult.data;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return this.needsHumanReview(
        ctx,
        emit,
        `Failed to parse architecture re-verification result: ${message}`,
        ['architecture-review.json'],
      );
    }

    await this.persistReviewArtifacts(ctx, emit, revalData);

    const isRevalApproved = this.isVerdictApproved(revalData);
    const revalBlockingFindings = this.getBlockingFindings(revalData);

    if (isRevalApproved && revalBlockingFindings.length === 0) {
      emit(
        'architecture_review.completed',
        'info',
        'architecture review approved after targeted correction and verification',
        { policy: ctx.executionPolicy },
      );
      return { outcome: 'passed' };
    }

    // Budget exhausted (1 review + 1 fix + 1 verification) -> Escalate to human review
    const failureSummary = `Architecture review did not converge within fixed budget: ${revalBlockingFindings.length} blocking finding(s) remain`;
    emit('architecture_review.exhausted', 'warn', failureSummary, {
      policy: ctx.executionPolicy,
      remainingFindingsCount: revalBlockingFindings.length,
    });

    return this.needsHumanReview(ctx, emit, failureSummary, [
      'architecture-review.json',
      'design.md',
      'plan.md',
    ]);
  }

  private isVerdictApproved(result: ArchitectureReviewResult): boolean {
    const v = result.verdict.toUpperCase();
    return v === 'APPROVE' || v === 'PASS';
  }

  private getBlockingFindings(result: ArchitectureReviewResult) {
    const isExplicitlyApproved = this.isVerdictApproved(result);
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
  ): string {
    const lines: string[] = [];
    if (result.summary) {
      lines.push(`### Review Summary\n${result.summary}\n`);
    }

    if (result.requirements_checks && result.requirements_checks.length > 0) {
      const failedChecks = result.requirements_checks.filter(
        (c) => c.result.toUpperCase() === 'FAIL',
      );
      if (failedChecks.length > 0) {
        lines.push('### Failed Requirements Checks:');
        for (const check of failedChecks) {
          lines.push(`- [FAIL] ${check.requirement}: ${check.evidence ?? 'No evidence provided'}`);
        }
        lines.push('');
      }
    }

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

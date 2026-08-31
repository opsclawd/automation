import { PhaseName, AgentProfileName, type Failure, type FailureKind } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { ArtifactNotFoundError } from '../../ports/artifact-store.js';
import { runSingleShotAgentPhase } from './run-single-shot-agent-phase.js';
import { loadPromptTemplate } from '../../prompts/load-prompt-template.js';
import {
  postImplementationQualityReviewResultSchema,
  isApprovedQualityReview,
  type PostImplementationQualityReviewResult,
} from '../../results/schemas/post-implementation-quality-review.js';
import {
  createFindingLedger,
  appendFindingLedgerEntries,
  type FindingLedger,
} from '../../review-fix/finding-ledger.js';
import {
  verifyValidationFreshness,
  isReviewApprovalFresh,
  listOrchestratorOwnedUntrackedPaths,
} from '../validation-evidence.js';
import { formatOrchestratorOwnedUntrackedPathsForPrompt } from '../../artifacts/orchestrator-artifacts.js';

export interface QualityReviewHandlerOpts {
  profileName?: string;
}

export class QualityReviewHandler implements PhaseHandler {
  readonly phase = PhaseName('quality-review');

  constructor(private readonly opts: QualityReviewHandlerOpts = {}) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('quality_review.started', 'info', 'post-implementation quality review started', {
      policy: ctx.executionPolicy,
    });

    // 1. Resume / idempotency check
    try {
      const existingRaw = await ctx.artifacts.read(ctx.runUuid, 'quality-review.json');
      if (existingRaw.trim().length > 0) {
        const parsedObj = JSON.parse(existingRaw);
        const parseResult = postImplementationQualityReviewResultSchema.safeParse(parsedObj);
        if (parseResult.success) {
          const isApproved = isApprovedQualityReview(parseResult.data);
          const isFresh = await isReviewApprovalFresh(ctx, 'quality-review');
          const validationFreshness = await verifyValidationFreshness(ctx);
          if (isApproved && isFresh && validationFreshness.fresh) {
            emit(
              'quality_review.completed',
              'info',
              'quality review already approved (reusing existing review)',
              { policy: ctx.executionPolicy },
            );
            return { outcome: 'passed' };
          }
        }
      }
    } catch {
      // Artifact not present or invalid, proceed with review
    }

    // 2. Validate required inputs: issue.md is mandatory; design.md, plan.md, issue-comments.md optional
    try {
      await ctx.artifacts.read(ctx.runUuid, 'issue.md');
    } catch (e) {
      const message =
        e instanceof ArtifactNotFoundError
          ? 'issue.md not found in artifact store'
          : `Failed to read issue.md: ${e instanceof Error ? e.message : String(e)}`;
      return this.fail(ctx, emit, 'missing_artifact', message);
    }

    // 3. Collect complete branch diff against base
    const baseBranch = ctx.expectedBranch ?? ctx.baseBranch ?? 'main';
    let completeDiff = '';
    try {
      if (ctx.git?.diff) {
        completeDiff = await ctx.git.diff(ctx.cwd, ctx.startCommitSha ?? baseBranch);
      }
    } catch {
      completeDiff = '';
    }

    // 4. Verify and collect deterministic validation evidence
    const freshness = await verifyValidationFreshness(ctx);
    if (!freshness.fresh) {
      const message = `Quality review blocked: deterministic validation has not passed or is stale (${freshness.reason ?? 'unknown reason'})`;
      return this.fail(
        ctx,
        emit,
        'validation_failed',
        message,
        'Run deterministic validation before executing quality review.',
      );
    }
    const validationEvidence = `Validation result: passed (fingerprint: ${freshness.expectedFingerprint?.slice(0, 12) ?? 'verified'})`;

    // 5. Read spec review summary if available
    let specReviewSummary = '(spec review summary unavailable)';
    try {
      const specRaw = await ctx.artifacts.read(ctx.runUuid, 'spec-review.json');
      const specData = JSON.parse(specRaw) as { verdict?: string; summary?: string };
      specReviewSummary = `Spec review verdict: ${specData.verdict ?? 'unknown'}${specData.summary ? ` - ${specData.summary}` : ''}`;
    } catch {
      // Best-effort
    }

    // 6. Resolve reviewer profile
    if (!ctx.resolveProfile) {
      return this.fail(ctx, emit, 'command_failed', 'resolveProfile not available on context');
    }
    const resolve = (p: string) => {
      try {
        return ctx.resolveProfile?.(p);
      } catch {
        return undefined;
      }
    };
    const profile =
      resolve('post-implementation-quality-review') ??
      resolve('quality-review') ??
      resolve('critic') ??
      resolve('pr-reviewer') ??
      resolve('implement') ??
      AgentProfileName(this.opts.profileName ?? 'opencode-frontier');

    // 7. Load prompt template
    let template: string | undefined;
    if (ctx.promptsRoot) {
      try {
        template = loadPromptTemplate('review-fix', 'quality-review', {
          promptsRoot: ctx.promptsRoot,
        });
      } catch {
        // Handled in runSingleShotAgentPhase
      }
    }

    const orchestratorOwnedPaths = await listOrchestratorOwnedUntrackedPaths(ctx);

    // 8. Invoke single-shot reviewer agent
    const runResult = await runSingleShotAgentPhase(ctx, {
      phase: 'quality-review',
      profile,
      step: 'quality-review',
      ...(template ? { template } : {}),
      vars: {
        issue_number: String(ctx.issueNumber),
        cwd: ctx.cwd,
        complete_diff: completeDiff || '(no diff)',
        validation_evidence: validationEvidence,
        spec_review_summary: specReviewSummary,
        orchestrator_bookkeeping_files:
          formatOrchestratorOwnedUntrackedPathsForPrompt(orchestratorOwnedPaths),
      },
      agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
      resultMeta: {
        schema: postImplementationQualityReviewResultSchema,
        schemaContractText:
          '{\n  "verdict": "APPROVE" | "REQUEST_CHANGES",\n  "findings"?: Array<{\n    "category"?: "correctness" | "architecture" | "reliability" | "error_handling" | "security" | "data_integrity" | "concurrency_performance" | "maintainability" | "scope" | "contract_change" | "scratch_artifact" | "test_quality" | "production_fidelity" | "other",\n    "severity": "critical" | "high" | "medium" | "low" | "P0" | "P1" | "P2" | "P3",\n    "files"?: string[],\n    "evidence": string,\n    "rationale": string,\n    "minimal_correction": string,\n    "blocking"?: boolean\n  }>,\n  "summary"?: string,\n  "review_md"?: string\n}',
      },
      skipCompletedEmit: true,
    });

    if (runResult.outcome !== 'passed') {
      emit('quality_review.failed', 'error', 'quality reviewer invocation failed');
      return runResult;
    }

    // 9. Extract and enforce deterministic gate
    const reviewData: PostImplementationQualityReviewResult = { ...runResult.result };
    const isApproved = isApprovedQualityReview(reviewData);
    const effectiveVerdict: 'APPROVE' | 'REQUEST_CHANGES' = isApproved
      ? 'APPROVE'
      : 'REQUEST_CHANGES';
    reviewData.verdict = effectiveVerdict;

    // 10. Update finding ledger with quality review findings
    let ledger: FindingLedger;
    try {
      const ledgerRaw = await ctx.artifacts.read(ctx.runUuid, 'finding-ledger.json');
      ledger = JSON.parse(ledgerRaw) as FindingLedger;
    } catch {
      ledger = createFindingLedger([], [], 'spec-review');
    }

    const updatedLedger = appendFindingLedgerEntries(
      ledger,
      reviewData.findings ?? [],
      'quality-review',
    );

    // 11. Format combined code-review.md
    const qualityReviewMd = this.formatReviewMarkdown(reviewData);
    let specReviewMd = '';
    try {
      specReviewMd = await ctx.artifacts.read(ctx.runUuid, 'spec-review.md');
    } catch {
      specReviewMd = '';
    }

    const combinedReviewMd = specReviewMd
      ? `${specReviewMd}\n\n---\n\n${qualityReviewMd}`
      : qualityReviewMd;

    // 12. Persist review artifacts
    try {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'quality-review.json',
        contents: JSON.stringify(reviewData, null, 2),
      });
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'quality-review.md',
        contents: qualityReviewMd,
      });
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'code-review.md',
        contents: combinedReviewMd,
      });
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'finding-ledger.json',
        contents: JSON.stringify(updatedLedger, null, 2),
      });

      const reviewedHeadSha = await ctx.git?.headCommitSha(ctx.cwd).catch(() => undefined);
      if (reviewedHeadSha?.trim()) {
        await ctx.artifacts.write({
          runId: ctx.runUuid,
          phaseId: this.phase,
          relativePath: 'quality-review-head-sha.txt',
          contents: reviewedHeadSha.trim(),
        });
        await ctx.artifacts.write({
          runId: ctx.runUuid,
          phaseId: this.phase,
          relativePath: 'review-head-sha.txt',
          contents: reviewedHeadSha.trim(),
        });
      }
    } catch (writeErr) {
      return this.fail(
        ctx,
        emit,
        'command_failed',
        `Failed to persist quality review artifacts: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        'Ensure artifact storage directory is writable.',
      );
    }

    if (effectiveVerdict === 'APPROVE') {
      emit('quality_review.completed', 'info', 'quality review approved', {
        policy: ctx.executionPolicy,
        verdict: 'APPROVE',
      });
      return { outcome: 'passed' };
    }

    emit('quality_review.changes_requested', 'warn', 'quality review requested changes', {
      policy: ctx.executionPolicy,
      verdict: 'REQUEST_CHANGES',
      findingsCount: reviewData.findings?.length ?? 0,
    });
    emit('quality_review.completed', 'info', 'quality review completed with changes requested');
    return { outcome: 'passed' };
  }

  private formatReviewMarkdown(review: PostImplementationQualityReviewResult): string {
    const lines: string[] = [
      '# Quality Review',
      '',
      `**Verdict:** ${review.verdict}`,
      ...(review.summary ? [`**Summary:** ${review.summary}`, ''] : ['']),
      '## Findings',
      '',
    ];

    if (!review.findings || review.findings.length === 0) {
      lines.push('No defects or blocking findings identified.');
    } else {
      for (const f of review.findings) {
        const categoryTag = f.category ? ` (${f.category})` : '';
        lines.push(`### [${f.severity.toUpperCase()}]${categoryTag} Finding`);
        if (f.files && f.files.length > 0) {
          lines.push(`- **Files:** ${f.files.join(', ')}`);
        }
        lines.push(`- **Evidence:** ${f.evidence}`);
        lines.push(`- **Rationale:** ${f.rationale}`);
        lines.push(`- **Minimal Correction:** ${f.minimal_correction}`);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  private fail(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
    kind: FailureKind,
    message: string,
    suggestedAction?: string,
  ): PhaseResult {
    const failure: Failure = {
      runUuid: ctx.runUuid,
      phase: this.phase as string,
      kind,
      message,
      canRetry: kind !== 'invalid_result',
      suggestedAction: suggestedAction ?? 'Inspect the quality review logs and retry.',
      artifacts: [],
      detectedAt: ctx.now(),
    };
    emit('quality_review.failed', 'error', message);
    return { outcome: 'failed', failure };
  }
}

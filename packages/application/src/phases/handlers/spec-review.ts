import { PhaseName, AgentProfileName, type Failure, type FailureKind } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { ArtifactNotFoundError } from '../../ports/artifact-store.js';
import { runSingleShotAgentPhase } from './run-single-shot-agent-phase.js';
import { loadPromptTemplate } from '../../prompts/load-prompt-template.js';
import {
  postImplementationSpecReviewResultSchema,
  isApprovedSpecReview,
  type PostImplementationSpecReviewResult,
} from '../../results/schemas/post-implementation-spec-review.js';
import {
  buildRequirementsLedger,
  formatRequirementsLedgerForPrompt,
  type RequirementsLedger,
} from '../requirements-ledger.js';
import { createFindingLedger } from '../../review-fix/finding-ledger.js';
import { verifyValidationFreshness, isReviewApprovalFresh } from '../validation-evidence.js';
import { formatOrchestratorBookkeepingFilesForPrompt } from '../../artifacts/orchestrator-artifacts.js';

export interface SpecReviewHandlerOpts {
  profileName?: string;
}

export class SpecReviewHandler implements PhaseHandler {
  readonly phase = PhaseName('spec-review');

  constructor(private readonly opts: SpecReviewHandlerOpts = {}) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('spec_review.started', 'info', 'post-implementation spec review started', {
      policy: ctx.executionPolicy,
    });

    // 1. Resume / idempotency check
    try {
      const existingRaw = await ctx.artifacts.read(ctx.runUuid, 'spec-review.json');
      if (existingRaw.trim().length > 0) {
        const parsedObj = JSON.parse(existingRaw);
        const parseResult = postImplementationSpecReviewResultSchema.safeParse(parsedObj);
        if (parseResult.success) {
          let existingLedger: RequirementsLedger | undefined;
          try {
            const ledgerRaw = await ctx.artifacts.read(
              ctx.runUuid,
              'spec-requirements-ledger.json',
            );
            existingLedger = JSON.parse(ledgerRaw) as RequirementsLedger;
          } catch {
            // Ledger artifact may not exist yet
          }
          const isApproved = isApprovedSpecReview(parseResult.data, existingLedger);
          const isFresh = await isReviewApprovalFresh(ctx, 'spec-review');
          const validationFreshness = await verifyValidationFreshness(ctx);
          if (isApproved && isFresh && validationFreshness.fresh) {
            emit(
              'spec_review.completed',
              'info',
              'spec review already approved (reusing existing review)',
              { policy: ctx.executionPolicy },
            );
            return { outcome: 'passed' };
          }
        }
      }
    } catch {
      // Artifact not present or invalid, proceed with review
    }

    // 2. Validate required inputs: issue.md and design.md
    let issueMd: string;
    let designMd: string;
    let issueCommentsMd: string | undefined;
    try {
      issueMd = await ctx.artifacts.read(ctx.runUuid, 'issue.md');
      designMd = await ctx.artifacts.read(ctx.runUuid, 'design.md');
    } catch (e) {
      const message =
        e instanceof ArtifactNotFoundError
          ? 'issue.md or design.md not found in artifact store'
          : `Failed to read review inputs: ${e instanceof Error ? e.message : String(e)}`;
      return this.fail(ctx, emit, 'missing_artifact', message);
    }

    try {
      issueCommentsMd = await ctx.artifacts.read(ctx.runUuid, 'issue-comments.md');
    } catch {
      // Optional input
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
      const message = `Spec review blocked: deterministic validation has not passed or is stale (${freshness.reason ?? 'unknown reason'})`;
      return this.fail(
        ctx,
        emit,
        'validation_failed',
        message,
        'Run deterministic validation before executing spec review.',
      );
    }
    const validationEvidence = `Validation result: passed (fingerprint: ${freshness.expectedFingerprint?.slice(0, 12) ?? 'verified'})`;

    // 5. Build or read deterministic requirements ledger
    let ledger: RequirementsLedger;
    try {
      const existingLedgerRaw = await ctx.artifacts.read(
        ctx.runUuid,
        'spec-requirements-ledger.json',
      );
      ledger = JSON.parse(existingLedgerRaw) as RequirementsLedger;
    } catch {
      ledger = await buildRequirementsLedger({
        issueNumber: ctx.issueNumber,
        repoFullName: ctx.repoFullName,
        issueMd,
        issueCommentsMd,
        designMd,
        github: ctx.github,
      });
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'spec-requirements-ledger.json',
        contents: JSON.stringify(ledger, null, 2),
      });
      emit('artifact.created', 'info', 'artifact created: spec-requirements-ledger.json', {
        relativePath: 'spec-requirements-ledger.json',
      });
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
      resolve('post-implementation-spec-review') ??
      resolve('spec-review') ??
      resolve('pr-reviewer') ??
      resolve('critic') ??
      resolve('implement') ??
      AgentProfileName(this.opts.profileName ?? 'opencode-frontier');

    // 7. Load prompt template
    let template: string | undefined;
    if (ctx.promptsRoot) {
      try {
        template = loadPromptTemplate('review-fix', 'spec-review', {
          promptsRoot: ctx.promptsRoot,
        });
      } catch {
        // Handled in runSingleShotAgentPhase
      }
    }

    const formattedLedger = formatRequirementsLedgerForPrompt(ledger);

    // 8. Invoke single-shot reviewer agent
    const runResult = await runSingleShotAgentPhase(ctx, {
      phase: 'spec-review',
      profile,
      step: 'spec-review',
      ...(template ? { template } : {}),
      vars: {
        issue_number: String(ctx.issueNumber),
        cwd: ctx.cwd,
        complete_diff: completeDiff || '(no diff)',
        validation_evidence: validationEvidence,
        requirements_ledger: formattedLedger,
        orchestrator_bookkeeping_files: formatOrchestratorBookkeepingFilesForPrompt(),
      },
      agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
      resultMeta: {
        schema: postImplementationSpecReviewResultSchema,
        schemaContractText:
          '{\n  "verdict": "PASS" | "FAIL",\n  "requirements_checks": Array<{\n    "requirement_id": string,\n    "requirement": string,\n    "result": "PASS" | "FAIL",\n    "evidence": string,\n    "test_evidence"?: string,\n    "counterexample_considered"?: string\n  }>,\n  "findings"?: Array<{\n    "severity": "critical" | "high" | "medium" | "low" | "P0" | "P1" | "P2" | "P3",\n    "files"?: string[],\n    "evidence": string,\n    "rationale": string,\n    "minimal_correction": string,\n    "blocking"?: boolean\n  }>,\n  "summary"?: string,\n  "review_md"?: string\n}',
      },
      skipCompletedEmit: true,
    });

    if (runResult.outcome !== 'passed') {
      emit('spec_review.failed', 'error', 'spec reviewer invocation failed');
      return runResult;
    }

    // 9. Extract and enforce deterministic gate
    const reviewData: PostImplementationSpecReviewResult = { ...runResult.result };
    const isApproved = isApprovedSpecReview(reviewData, ledger);
    const effectiveVerdict: 'PASS' | 'FAIL' = isApproved ? 'PASS' : 'FAIL';
    reviewData.verdict = effectiveVerdict;

    // Collect failed requirement checks for finding ledger
    const failingChecks: Array<{ requirement: string; result: string; evidence: string }> = [];
    const checks = reviewData.requirements_checks ?? [];
    for (const c of checks) {
      if (c.result?.toUpperCase() === 'FAIL') {
        failingChecks.push({
          requirement: c.requirement,
          result: 'FAIL',
          evidence: c.evidence,
        });
      }
    }
    // Check for omitted ledger items
    for (const item of ledger.items) {
      const match = checks.find(
        (c) => c.requirement_id?.toUpperCase().trim() === item.id.toUpperCase().trim(),
      );
      if (!match) {
        failingChecks.push({
          requirement: `[${item.id}] ${item.title}`,
          result: 'FAIL',
          evidence: `Requirement was omitted from review disposition (Source: ${item.source})`,
        });
      } else if (
        item.hardGate &&
        (!match.counterexample_considered || match.counterexample_considered.trim().length === 0)
      ) {
        failingChecks.push({
          requirement: `[${item.id}] ${item.title}`,
          result: 'FAIL',
          evidence: `Hard-gate requirement missing required counterexample_considered disposition`,
        });
      }
    }

    const findingLedger = createFindingLedger(
      reviewData.findings ?? [],
      failingChecks,
      'spec-review',
    );

    // 10. Persist review artifacts
    const formattedReviewMd = this.formatReviewMarkdown(reviewData);
    try {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'spec-review.json',
        contents: JSON.stringify(reviewData, null, 2),
      });
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'spec-review.md',
        contents: formattedReviewMd,
      });
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'code-review.md',
        contents: formattedReviewMd,
      });
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'finding-ledger.json',
        contents: JSON.stringify(findingLedger, null, 2),
      });

      const reviewedHeadSha = await ctx.git?.headCommitSha(ctx.cwd).catch(() => undefined);
      if (reviewedHeadSha?.trim()) {
        await ctx.artifacts.write({
          runId: ctx.runUuid,
          phaseId: this.phase,
          relativePath: 'spec-review-head-sha.txt',
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
        `Failed to persist spec review artifacts: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        'Ensure artifact storage directory is writable.',
      );
    }

    if (effectiveVerdict === 'PASS') {
      emit('spec_review.completed', 'info', 'spec review approved', {
        policy: ctx.executionPolicy,
        verdict: 'PASS',
        requirementsCheckedCount: reviewData.requirements_checks?.length ?? 0,
      });
      return { outcome: 'passed' };
    }

    emit('spec_review.changes_requested', 'warn', 'spec review requested changes', {
      policy: ctx.executionPolicy,
      verdict: 'FAIL',
      findingsCount: (reviewData.findings?.length ?? 0) + failingChecks.length,
    });
    emit('spec_review.completed', 'info', 'spec review completed with changes requested');
    return { outcome: 'passed' };
  }

  private formatReviewMarkdown(review: PostImplementationSpecReviewResult): string {
    const lines: string[] = [
      '# Spec Review',
      '',
      `**Verdict:** ${review.verdict}`,
      ...(review.summary ? [`**Summary:** ${review.summary}`, ''] : ['']),
      '## Requirements Disposition',
      '',
    ];

    if (!review.requirements_checks || review.requirements_checks.length === 0) {
      lines.push('No requirements checks recorded.');
    } else {
      for (const check of review.requirements_checks) {
        lines.push(
          `- [${check.result.toUpperCase()}] [${check.requirement_id}] ${check.requirement}`,
        );
        lines.push(`  - **Implementation Evidence:** ${check.evidence}`);
        if (check.test_evidence) {
          lines.push(`  - **Test Evidence:** ${check.test_evidence}`);
        }
        if (check.counterexample_considered) {
          lines.push(`  - **Counterexample Considered:** ${check.counterexample_considered}`);
        }
      }
    }

    lines.push('', '## Findings', '');
    if (!review.findings || review.findings.length === 0) {
      lines.push('No defects or blocking findings identified.');
    } else {
      for (const f of review.findings) {
        lines.push(`### [${f.severity.toUpperCase()}] Finding`);
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
      suggestedAction: suggestedAction ?? 'Inspect the spec review logs and retry.',
      artifacts: [],
      detectedAt: ctx.now(),
    };
    emit('spec_review.failed', 'error', message);
    return { outcome: 'failed', failure };
  }
}

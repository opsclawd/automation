import {
  PhaseName,
  RunId,
  AgentProfileName,
  type Failure,
  type FailureKind,
} from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { ArtifactNotFoundError } from '../../ports/artifact-store.js';
import type { ValidationPort } from '../../ports/validation-port.js';
import type { RunWorkspaceTypecheckPort } from '../../ports/run-workspace-typecheck-port.js';
import type { RunValidation } from '../../run-validation.js';
import { recordValidationHeadSha } from '../validation-headsha.js';
import { runSingleShotAgentPhase } from './run-single-shot-agent-phase.js';
import { loadPromptTemplate } from '../../prompts/load-prompt-template.js';
import { PHASE_RESULT_REGISTRY } from '../../results/phase-registry.js';
import type { WholeChangeReviewResult } from '../../results/schemas/whole-change-review.js';
import type { NarrowVerificationResult } from '../../results/schemas/narrow-verification.js';
import {
  evaluateWholeChangeReviewVerdict,
  evaluateNarrowVerificationVerdict,
  type WholeChangeVerdictOutcome,
  type NarrowVerificationVerdictOutcome,
} from '../../review-fix/read-verdicts.js';

export interface ReviewFixHandlerOpts {
  /** Runs the legacy ReviewFixLoop and returns its terminal phase outcome.
   *  Injected so this handler is testable; the executor wires the
   *  real ReviewFixLoop.execute(...) here. */
  runLoop: (ctx: PhaseHandlerContext) => Promise<{
    phaseOutcome: 'passed' | 'failed';
    loopStatus: 'converged' | 'converged_with_notes' | 'failed' | 'exhausted';
    /** True when the loop short-circuited via the unfounded_pingpong path. */
    needsHumanReview?: boolean;
    /** Operator-facing reason for a needs-human-review short circuit. */
    humanReviewReason?: string;
  }>;
  /** Optional revalidation runner for deterministic validation of targeted fixes */
  revalidate?: {
    runValidation: RunValidation;
    commands: string[];
    timeoutSeconds: number;
    logDir: string;
  };
  validationPort?: ValidationPort;
  runWorkspaceTypecheck?: RunWorkspaceTypecheckPort;
}

export class ReviewFixHandler implements PhaseHandler {
  readonly phase = 'review-fix' as PhaseName;
  constructor(private readonly opts: ReviewFixHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const isLeanPolicy = ctx.executionPolicy === 'standard' || ctx.executionPolicy === 'strict';
    if (isLeanPolicy) {
      return this.runLean(ctx);
    }

    return this.runLegacy(ctx);
  }

  private async runLegacy(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('review_fix.started', 'info', 'review-fix started');

    let phaseOutcome: 'passed' | 'failed';
    let loopStatus: 'converged' | 'converged_with_notes' | 'failed' | 'exhausted';
    let result: Awaited<ReturnType<ReviewFixHandlerOpts['runLoop']>>;
    try {
      result = await this.opts.runLoop(ctx);
      phaseOutcome = result.phaseOutcome;
      loopStatus = result.loopStatus;
    } catch (e) {
      const message = `review/fix loop threw: ${e instanceof Error ? e.message : String(e)}`;
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'review-fix',
        kind: 'unknown',
        message,
        canRetry: true,
        suggestedAction:
          'Inspect the latest review.md and loop iterations, then resume or intervene.',
        artifacts: ['review.md'],
        detectedAt: ctx.now(),
      };
      emit('review_fix.failed', 'error', message);
      return { outcome: 'failed', failure };
    }

    if (phaseOutcome === 'passed' && !result.needsHumanReview) {
      emit('review_fix.completed', 'info', 'review-fix converged');
      return { outcome: 'passed' };
    }
    const terminalStatus: 'exhausted' | 'failed' =
      loopStatus === 'exhausted' ? 'exhausted' : 'failed';
    const isHumanReview = result.needsHumanReview === true;
    const verboseMessage = isHumanReview
      ? result.humanReviewReason && result.humanReviewReason.trim().length > 0
        ? result.humanReviewReason
        : 'review/fix loop short-circuited to needs_human_review (unfounded reviewer findings)'
      : terminalStatus === 'exhausted'
        ? 'review/fix loop exhausted without converging'
        : 'review/fix loop failed';
    const eventMessage = isHumanReview
      ? 'review-fix loop needs human review'
      : terminalStatus === 'exhausted'
        ? 'review-fix loop exhausted'
        : 'review-fix loop failed';
    emit('review_fix.failed', 'error', eventMessage);
    return {
      outcome: isHumanReview ? 'needs_human_review' : 'failed',
      failure: {
        runUuid: ctx.runUuid,
        phase: 'review-fix',
        kind: isHumanReview ? 'needs_human_review' : 'validation_failed',
        message: verboseMessage,
        canRetry: true,
        suggestedAction: isHumanReview
          ? 'Inspect code-review.md (rebuttal appended) and the latest review.md, then resume or intervene.'
          : 'Inspect the latest review.md and loop iterations, then resume or intervene.',
        artifacts: ['review.md', 'code-review.md'],
        detectedAt: ctx.now(),
      },
    };
  }

  private async runLean(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('review_fix.started', 'info', 'whole-change review started', {
      policy: ctx.executionPolicy,
    });

    // 1. Resume / idempotency check
    try {
      const wholeChangeResult = await ctx.artifacts.read(ctx.runUuid, 'whole-change-review.json');
      if (wholeChangeResult.trim().length > 0) {
        const parsed = JSON.parse(wholeChangeResult) as { verdict?: string };
        if (parsed.verdict === 'APPROVE' || parsed.verdict === 'approve') {
          emit(
            'review_fix.completed',
            'info',
            'whole-change review already approved (reusing existing review)',
            { policy: ctx.executionPolicy },
          );
          return { outcome: 'passed' };
        }
      }
    } catch {
      // Artifacts not present, proceed with review
    }

    try {
      const narrowVerificationResult = await ctx.artifacts.read(
        ctx.runUuid,
        'narrow-verification.json',
      );
      if (narrowVerificationResult.trim().length > 0) {
        const parsed = JSON.parse(narrowVerificationResult) as { verdict?: string };
        if (parsed.verdict === 'PASS' || parsed.verdict === 'pass') {
          emit(
            'review_fix.completed',
            'info',
            'narrow verification already passed (reusing existing verification)',
            { policy: ctx.executionPolicy },
          );
          return { outcome: 'passed' };
        }
      }
    } catch {
      // Artifacts not present, proceed
    }

    // 2. Validate issue truth is present
    let issueMd: string;
    try {
      issueMd = await ctx.artifacts.read(ctx.runUuid, 'issue.md');
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

    // 4. Collect validation evidence
    let validationEvidence = 'Validation Status: passed';
    try {
      const valResult = await ctx.artifacts.read(ctx.runUuid, 'validation.result');
      validationEvidence = `Validation result: ${valResult.trim()}`;
    } catch {
      // Best-effort
    }

    // 5. Resolve reviewer profile
    if (!ctx.resolveProfile) {
      return this.fail(ctx, emit, 'command_failed', 'resolveProfile not available on context');
    }
    const profile =
      ctx.resolveProfile('whole-change-review') ??
      ctx.resolveProfile(this.phase as string) ??
      ctx.resolveProfile('implement');
    if (!profile) {
      return this.fail(
        ctx,
        emit,
        'command_failed',
        `resolveProfile returned empty for phase '${this.phase}'`,
      );
    }

    // 6. Load prompt template
    let template: string | undefined;
    if (ctx.promptsRoot) {
      try {
        template = loadPromptTemplate('review-fix', 'whole-change-review', {
          promptsRoot: ctx.promptsRoot,
        });
      } catch {
        // Fallback handled by runSingleShotAgentPhase or injected template
      }
    }

    // 7. Invoke single-shot reviewer agent (read-only)
    const runResult = await runSingleShotAgentPhase<WholeChangeReviewResult>(ctx, {
      phase: this.phase,
      profile,
      step: 'whole-change-review',
      ...(template ? { template } : {}),
      vars: {
        issue_number: String(ctx.issueNumber),
        cwd: ctx.cwd,
        complete_diff: completeDiff || '(no diff)',
        validation_evidence: validationEvidence,
      },
      agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
      resultMeta: PHASE_RESULT_REGISTRY['whole-change-review']!,
      skipCompletedEmit: true,
    });

    if (runResult.outcome !== 'passed') {
      emit('review_fix.failed', 'error', 'whole-change reviewer invocation failed');
      return runResult;
    }

    // 8. Extract and validate structured review verdict
    const verdictOutcome = evaluateWholeChangeReviewVerdict(runResult.result, {
      issueBodyPresent: issueMd.trim().length > 0,
    });

    // Persist review artifacts (code-review.md and whole-change-review.json)
    const formattedReviewMd = this.formatReviewMarkdown(verdictOutcome);
    try {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'code-review.md',
        contents: formattedReviewMd,
      });
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'whole-change-review.json',
        contents: JSON.stringify(
          {
            verdict: verdictOutcome.verdict,
            acceptance_criteria: verdictOutcome.acceptanceCriteria,
            findings: verdictOutcome.findings,
            summary: verdictOutcome.summary,
            overridden: verdictOutcome.overridden,
            overrideReason: verdictOutcome.overrideReason,
          },
          null,
          2,
        ),
      });
    } catch {
      // Best-effort artifact write
    }

    // 9. Process verdict
    if (verdictOutcome.verdict === 'APPROVE') {
      emit('review_fix.completed', 'info', 'whole-change review approved', {
        policy: ctx.executionPolicy,
        verdict: 'APPROVE',
        acceptanceCriteriaCount: verdictOutcome.acceptanceCriteria.length,
      });
      return { outcome: 'passed' };
    }

    // 10. REQUEST_CHANGES -> Enter Single Targeted Fix Path
    emit('review_fix.changes_requested', 'warn', 'whole-change review requested changes', {
      policy: ctx.executionPolicy,
      verdict: 'REQUEST_CHANGES',
      findingsCount: verdictOutcome.findings.length,
      overrideReason: verdictOutcome.overrideReason,
    });

    return this.runTargetedFixAndVerification(ctx, emit, verdictOutcome);
  }

  private async runTargetedFixAndVerification(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
    reviewOutcome: Extract<WholeChangeVerdictOutcome, { ok: true }>,
  ): Promise<PhaseResult> {
    // === 1. TARGETED FIX ===
    emit('review_fix.targeted_fix_started', 'info', 'starting single targeted fix pass', {
      policy: ctx.executionPolicy,
    });

    const headBeforeFix = await ctx.git?.headCommitSha(ctx.cwd).catch(() => undefined);

    // Format findings for fix prompt
    const formattedFindings = this.formatFindingsForFix(reviewOutcome);

    // Resolve fix profile
    const fixProfile =
      ctx.resolveProfile?.('fix-review') ??
      ctx.resolveProfile?.('implement') ??
      AgentProfileName('opencode-frontier');

    // Load targeted fix template
    let fixTemplate: string | undefined;
    if (ctx.promptsRoot) {
      try {
        fixTemplate = loadPromptTemplate('review-fix', 'targeted-fix', {
          promptsRoot: ctx.promptsRoot,
        });
      } catch {
        // Handled in runSingleShotAgentPhase
      }
    }

    // Run fixer agent invocation
    const fixRunResult = await runSingleShotAgentPhase(ctx, {
      phase: this.phase,
      profile: fixProfile,
      step: 'targeted-fix',
      ...(fixTemplate ? { template: fixTemplate } : {}),
      vars: {
        issue_number: String(ctx.issueNumber),
        cwd: ctx.cwd,
        review_findings: formattedFindings,
      },
      agentContract: {
        requiredArtifacts: [],
        mustNotChangeBranch: true,
        mustNotCreateCommit: true,
      },
      skipResultExtraction: true,
    });

    if (fixRunResult.outcome !== 'passed') {
      emit('review_fix.failed', 'error', 'targeted fix agent failed');
      return fixRunResult;
    }

    emit('review_fix.targeted_fix_completed', 'info', 'targeted fix pass completed', {
      policy: ctx.executionPolicy,
    });

    // === 2. DETERMINISTIC REVALIDATION ===
    emit(
      'review_fix.revalidation_started',
      'info',
      'deterministic revalidation started after targeted fix',
      { policy: ctx.executionPolicy },
    );

    if (this.opts.revalidate) {
      try {
        const valResult = await this.opts.revalidate.runValidation.execute({
          runId: RunId(ctx.runUuid),
          phaseId: this.phase,
          cwd: ctx.cwd,
          logDir: this.opts.revalidate.logDir,
          commands: this.opts.revalidate.commands,
          timeoutSeconds: this.opts.revalidate.timeoutSeconds,
          env: { GITHUB_REPOSITORY: ctx.repoFullName },
        });

        if (!valResult.passed) {
          const failureMsg =
            valResult.failure?.message ?? 'deterministic validation failed after targeted fix';
          emit('review_fix.revalidation_failed', 'error', failureMsg, {
            policy: ctx.executionPolicy,
          });
          emit('review_fix.failed', 'error', failureMsg);
          return {
            outcome: 'failed',
            failure: valResult.failure ?? {
              runUuid: ctx.runUuid,
              phase: this.phase,
              kind: 'validation_failed',
              message: failureMsg,
              canRetry: true,
              suggestedAction: 'Inspect validation failure and resolve remaining issues.',
              artifacts: [],
              detectedAt: ctx.now(),
            },
          };
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        emit('review_fix.revalidation_failed', 'error', message, {
          policy: ctx.executionPolicy,
        });
        return this.fail(
          ctx,
          emit,
          'unknown',
          `targeted fix deterministic validation threw: ${message}`,
        );
      }
    } else if (this.opts.runWorkspaceTypecheck) {
      const typecheckResult = await this.opts.runWorkspaceTypecheck({ cwd: ctx.cwd });
      if (!typecheckResult.ok) {
        const msg = `typecheck failed after targeted fix: ${typecheckResult.error}`;
        emit('review_fix.revalidation_failed', 'error', msg, { policy: ctx.executionPolicy });
        emit('review_fix.failed', 'error', msg);
        return this.fail(ctx, emit, 'validation_failed', msg);
      }
    }

    // Record validation head SHA
    await recordValidationHeadSha(ctx, 'review-fix');
    try {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'validation.result',
        contents: 'passed\n',
      });
    } catch {
      // Best-effort
    }

    emit(
      'review_fix.revalidation_completed',
      'info',
      'deterministic revalidation passed after targeted fix',
      { policy: ctx.executionPolicy },
    );

    // === 3. NARROW VERIFICATION ===
    emit('review_fix.verification_started', 'info', 'narrow verification started', {
      policy: ctx.executionPolicy,
    });

    const baseBranch = ctx.expectedBranch ?? ctx.baseBranch ?? 'main';
    let fixDiff = '';
    try {
      if (ctx.git?.diff) {
        fixDiff = await ctx.git.diff(ctx.cwd, headBeforeFix ?? ctx.startCommitSha ?? baseBranch);
      }
    } catch {
      fixDiff = '';
    }

    let validationEvidence = 'Validation Status: passed';
    try {
      const valResult = await ctx.artifacts.read(ctx.runUuid, 'validation.result');
      validationEvidence = `Validation result: ${valResult.trim()}`;
    } catch {
      // Best-effort
    }

    const verifyProfile =
      ctx.resolveProfile?.('whole-change-review') ??
      ctx.resolveProfile?.('spec-review') ??
      ctx.resolveProfile?.('implement') ??
      AgentProfileName('opencode-frontier');

    let verifyTemplate: string | undefined;
    if (ctx.promptsRoot) {
      try {
        verifyTemplate = loadPromptTemplate('review-fix', 'narrow-verification', {
          promptsRoot: ctx.promptsRoot,
        });
      } catch {
        // Handled in runSingleShotAgentPhase
      }
    }

    const verifyRunResult = await runSingleShotAgentPhase<NarrowVerificationResult>(ctx, {
      phase: this.phase,
      profile: verifyProfile,
      step: 'narrow-verification',
      ...(verifyTemplate ? { template: verifyTemplate } : {}),
      vars: {
        issue_number: String(ctx.issueNumber),
        cwd: ctx.cwd,
        review_findings: formattedFindings,
        validation_evidence: validationEvidence,
        fix_diff: fixDiff || '(no diff)',
      },
      agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
      resultMeta: PHASE_RESULT_REGISTRY['narrow-verification']!,
      skipCompletedEmit: true,
    });

    if (verifyRunResult.outcome !== 'passed') {
      emit('review_fix.verification_failed', 'error', 'narrow verifier invocation failed', {
        policy: ctx.executionPolicy,
      });
      emit('review_fix.failed', 'error', 'narrow verifier invocation failed');
      return verifyRunResult;
    }

    const originalFindingsCount =
      reviewOutcome.findings.length +
      reviewOutcome.acceptanceCriteria.filter((c) => c.result?.toUpperCase() === 'FAIL').length;

    const verifyOutcome = evaluateNarrowVerificationVerdict(verifyRunResult.result, {
      originalFindingsCount,
    });

    // Persist verification artifacts
    const formattedVerificationMd = this.formatVerificationMarkdown(verifyOutcome);
    try {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'verification.md',
        contents: formattedVerificationMd,
      });
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'narrow-verification.json',
        contents: JSON.stringify(
          {
            verdict: verifyOutcome.verdict,
            findings_evaluations: verifyOutcome.evaluations,
            obvious_regressions: verifyOutcome.regressions,
            summary: verifyOutcome.summary,
            overridden: verifyOutcome.overridden,
            overrideReason: verifyOutcome.overrideReason,
          },
          null,
          2,
        ),
      });
    } catch {
      // Best-effort artifact write
    }

    if (verifyOutcome.verdict === 'PASS') {
      emit('review_fix.verification_completed', 'info', 'narrow verification passed', {
        policy: ctx.executionPolicy,
        verdict: 'PASS',
        evaluationsCount: verifyOutcome.evaluations.length,
      });
      emit(
        'review_fix.completed',
        'info',
        'targeted fix applied and verified successfully — advancing to PR creation',
        { policy: ctx.executionPolicy },
      );
      return { outcome: 'passed' };
    }

    // Verification FAIL transitions to needs_human_review (explicit blocker state, no retry loop)
    const failReason =
      verifyOutcome.overrideReason ??
      (verifyOutcome.regressions.length > 0
        ? `Regressions detected: ${verifyOutcome.regressions.join('; ')}`
        : 'Narrow verification rejected the fix');

    emit('review_fix.verification_failed', 'error', `narrow verification failed: ${failReason}`, {
      policy: ctx.executionPolicy,
      verdict: 'FAIL',
      reason: failReason,
    });
    emit('review_fix.failed', 'error', `narrow verification failed: ${failReason}`);

    return {
      outcome: 'needs_human_review',
      failure: {
        runUuid: ctx.runUuid,
        phase: this.phase,
        kind: 'needs_human_review',
        message: `narrow verification failed: ${failReason}`,
        canRetry: true,
        suggestedAction:
          'Inspect verification.md, code-review.md, and the latest fix, then intervene or resume.',
        artifacts: [
          'code-review.md',
          'whole-change-review.json',
          'verification.md',
          'narrow-verification.json',
        ],
        detectedAt: ctx.now(),
      },
    };
  }

  private formatVerificationMarkdown(
    outcome: Extract<NarrowVerificationVerdictOutcome, { ok: true }>,
  ): string {
    const lines: string[] = [
      '# Narrow Verification Report',
      '',
      `**Verdict:** ${outcome.verdict}`,
      ...(outcome.summary ? [`**Summary:** ${outcome.summary}`, ''] : ['']),
      '## Findings Evaluations',
      '',
    ];

    if (outcome.evaluations.length === 0) {
      lines.push('No finding evaluations recorded.');
    } else {
      for (const ev of outcome.evaluations) {
        lines.push(`### [${ev.resolved ? 'RESOLVED' : 'UNRESOLVED'}] ${ev.finding}`);
        lines.push(`- **Evidence:** ${ev.evidence}`);
        if (ev.rationale) {
          lines.push(`- **Rationale:** ${ev.rationale}`);
        }
        lines.push('');
      }
    }

    lines.push('## Obvious Regressions', '');
    if (outcome.regressions.length === 0) {
      lines.push('No obvious regressions detected in the touched area.');
    } else {
      for (const reg of outcome.regressions) {
        lines.push(`- [REGRESSION] ${reg}`);
      }
    }

    return lines.join('\n');
  }

  private formatFindingsForFix(outcome: Extract<WholeChangeVerdictOutcome, { ok: true }>): string {
    const lines: string[] = [];

    const failingCriteria = outcome.acceptanceCriteria.filter(
      (c) => c.result?.toUpperCase() === 'FAIL',
    );
    if (failingCriteria.length > 0) {
      lines.push('### FAILED ACCEPTANCE CRITERIA:');
      for (const fc of failingCriteria) {
        lines.push(`- [FAIL] ${fc.criterion}${fc.evidence ? `: ${fc.evidence}` : ''}`);
      }
      lines.push('');
    }

    if (outcome.findings.length > 0) {
      lines.push('### BLOCKING REVIEW FINDINGS:');
      for (const f of outcome.findings) {
        lines.push(`- [${f.severity.toUpperCase()}] ${f.rationale}`);
        if (f.files && f.files.length > 0) {
          lines.push(`  Files: ${f.files.join(', ')}`);
        }
        lines.push(`  Evidence: ${f.evidence}`);
        lines.push(`  Required Fix: ${f.minimal_correction}`);
      }
      lines.push('');
    }

    if (outcome.overrideReason) {
      lines.push(`Reason for change request: ${outcome.overrideReason}`);
    }

    return lines.join('\n');
  }

  private formatReviewMarkdown(outcome: Extract<WholeChangeVerdictOutcome, { ok: true }>): string {
    const lines: string[] = [
      '# Whole-Change Review',
      '',
      `**Verdict:** ${outcome.verdict}`,
      ...(outcome.summary ? [`**Summary:** ${outcome.summary}`, ''] : ['']),
      '## Acceptance Criteria Evaluation',
      '',
    ];

    if (outcome.acceptanceCriteria.length === 0) {
      lines.push('No acceptance criteria listed.');
    } else {
      for (const ac of outcome.acceptanceCriteria) {
        lines.push(`- [${ac.result.toUpperCase()}] ${ac.criterion}`);
        if (ac.evidence) {
          lines.push(`  - Evidence: ${ac.evidence}`);
        }
      }
    }

    lines.push('', '## Findings', '');
    if (outcome.findings.length === 0) {
      lines.push('No defects or blocking findings identified.');
    } else {
      for (const f of outcome.findings) {
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
    emit('review_fix.failed', 'error', message);
    return {
      outcome: 'failed',
      failure: {
        runUuid: ctx.runUuid,
        phase: this.phase,
        kind,
        message,
        canRetry: kind !== 'invalid_result',
        suggestedAction:
          suggestedAction ?? 'Inspect the review-fix phase logs and retry or resume.',
        artifacts: ['code-review.md', 'whole-change-review.json'],
        detectedAt: ctx.now(),
      },
    };
  }
}

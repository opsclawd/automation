import {
  createLoop,
  startIteration,
  completeIteration,
  canIterate,
  exhaust,
  type AgentProfileName,
} from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import {
  detectStall,
  detectUnfoundedPingPong,
  fingerprintFindings,
  type FindingHistoryEntry,
} from './detect-stall.js';
import { extractEvidence } from './extract-evidence.js';
import { appendRebuttalToCodeReview } from './append-rebuttal.js';
import type {
  ReviewFixLoopDeps,
  ReviewFixLoopInput,
  ReviewFixLoopResult,
  StepContext,
  PostFixGateResult,
  ReviewLoopHistoryAudience,
  ReviewLoopHistoryEntry,
  ReviewStepResult,
  FixStepResult,
  RevalidationResult,
} from './types.js';

export class ReviewFixLoop {
  constructor(private readonly deps: ReviewFixLoopDeps) {}

  async execute(input: ReviewFixLoopInput): Promise<ReviewFixLoopResult> {
    const { deps } = this;
    let loop = createLoop({
      id: deps.idFactory(),
      runId: input.runId,
      phaseId: input.phaseId,
      type: 'review-fix',
      maxIterations: input.maxIterations,
      now: deps.now(),
    });
    deps.loops.insert(loop);

    let consecutiveFixFailures = 0;
    let lastFixInvocationId: string | undefined;
    let lastFailingCategory: string | undefined;
    let lastIterationHadFixCommit = false;
    let outstandingFailedRevalidation = false;
    const findingHistory: Array<Set<string>> = [];
    const unfoundedHistory: FindingHistoryEntry[] = [];

    while (canIterate(loop)) {
      const iterationIndex = loop.iterations.length + 1;
      const ctx: StepContext = {
        loopId: loop.id,
        runId: input.runId,
        phaseId: input.phaseId,
        repoId: input.repoId,
        cwd: input.cwd,
        iterationIndex,
      };

      // --- POST-FIX GATE (skip iteration 1 — fixer has not yet committed) ---
      let gateResult: PostFixGateResult | undefined;
      if (iterationIndex > 1 && lastIterationHadFixCommit) {
        gateResult = await deps.runPostFixGate(ctx);
      }

      // --- REVIEW ---
      this.emit(
        input,
        'loop.iteration.started',
        'info',
        `review/fix iteration ${iterationIndex} started`,
        {
          index: iterationIndex,
        },
      );
      const historyContext = await this.readHistoryContext(ctx, 'reviewer', input);
      const reviewOptions = {
        ...(gateResult ? { gateResult } : {}),
        ...(historyContext ? { historyContext } : {}),
      };
      const review = await deps.runReview(
        ctx,
        Object.keys(reviewOptions).length > 0 ? reviewOptions : undefined,
      );
      if (review.overridden) {
        const direction: 'upgrade' | 'downgrade' =
          review.verdict === 'fail' ? 'upgrade' : 'downgrade';
        const message =
          direction === 'upgrade'
            ? `review returned pass but severity gate overrode to fail`
            : `review returned fail but severity gate overrode to pass (all findings below threshold)`;
        this.emit(input, 'review.verdict.overridden', 'warn', message, {
          direction,
          iterationIndex,
          offendingFindings: review.offendingFindings ?? [],
          threshold: input.blockOnSeverity ?? 'high',
        });
      }
      loop = startIteration(loop, { reviewInvocationId: review.invocationId, now: deps.now() });
      deps.loops.update(loop);

      if (review.agentOutcome !== 'success' || review.verdict === undefined) {
        loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'failed');
        await this.appendHistoryEntry(ctx, review, undefined, undefined, 'failed', input);
        await this.runCleanArtifacts(ctx);
        break;
      }

      if (review.verdict === 'pass') {
        if (outstandingFailedRevalidation) {
          const reval = await deps.runRevalidation(ctx);
          outstandingFailedRevalidation = !reval.passed;
          if (reval.passed) {
            loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
            deps.loops.update(loop);
            this.emitIterationCompleted(input, iterationIndex, 'resolved');
            await this.appendHistoryEntry(ctx, review, undefined, reval, 'resolved', input);
            break;
          }
          loop = completeIteration(loop, {
            outcome: 'unresolved',
            revalidationId: reval.validationRunId,
            now: deps.now(),
          });
          deps.loops.update(loop);
          this.emitIterationCompleted(input, iterationIndex, 'unresolved');
          await this.appendHistoryEntry(ctx, review, undefined, reval, 'unresolved', input);
          continue;
        }
        loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'resolved');
        await this.appendHistoryEntry(ctx, review, undefined, undefined, 'resolved', input);
        break;
      }

      // --- STRUCTURAL EVIDENCE CHECK (rebuttal-aware convergence) ---
      const unfoundedList = await this.checkReviewerEvidence(input, review, iterationIndex);
      const unfoundedCount = unfoundedList.length;
      const unfoundedFingerprints = fingerprintFindings(unfoundedList);

      // --- OSCILLATION / STALL DETECTION ---
      const normalizedFindings = fingerprintFindings(review.offendingFindings ?? []);
      findingHistory.push(normalizedFindings);
      if (findingHistory.length > 3) {
        findingHistory.splice(0, findingHistory.length - 3);
      }
      const stall = detectStall(findingHistory);

      // --- REBUTTAL-AWARE CONVERGENCE (after the fix step returns) ---
      // The actual convergence check fires after `runFix` runs and reports its
      // verdict — see below. Here we just record the unfounded count so the
      // post-fix branch can read it.

      // --- decide fallback (use-case-owned triggers) ---
      const escalateForFixFailures =
        consecutiveFixFailures >= 2 && input.fixFallbackProfile !== undefined;
      const escalateForStall = stall !== 'none' && input.fixFallbackProfile !== undefined;
      const useFallback = escalateForFixFailures || escalateForStall;
      if (escalateForFixFailures) {
        this.emitEscalation(input, 'two_consecutive_fix_failures');
      }
      if (escalateForStall) {
        this.emitEscalation(
          input,
          stall === 'oscillation' ? 'oscillation_detected' : 'no_progress_detected',
        );
      }

      // --- FIX ---
      const fixerHistoryContext = await this.readHistoryContext(ctx, 'fixer', input);
      const fix = await deps.runFix(ctx, {
        useFallback,
        ...(useFallback && lastFixInvocationId !== undefined
          ? { previousInvocationId: lastFixInvocationId }
          : {}),
        ...(input.architectPlan !== undefined ? { architectPlan: input.architectPlan } : {}),
        ...(fixerHistoryContext ? { historyContext: fixerHistoryContext } : {}),
      });
      lastFixInvocationId = fix.invocationId;

      if (
        fix.agentOutcome !== 'success' ||
        fix.verdict === undefined ||
        fix.verdict === 'cannot_fix'
      ) {
        consecutiveFixFailures += 1;
        lastIterationHadFixCommit = false;
        loop = completeIteration(loop, {
          outcome: 'unresolved',
          fixInvocationId: fix.invocationId,
          now: deps.now(),
        });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'unresolved');
        await this.appendHistoryEntry(ctx, review, fix, undefined, 'unresolved', input);
        // Record fixer verdict in unfounded-history even on fix failure so
        // the ping-pong detector can see it.
        unfoundedHistory.push({
          findings: unfoundedFingerprints,
          ...(fix.verdict ? { fixerVerdict: fix.verdict } : {}),
        });
        await this.runCleanArtifacts(ctx);
        continue;
      }
      consecutiveFixFailures = 0;
      lastIterationHadFixCommit = fix.verdict === 'done_with_fixes';

      // --- REVALIDATE ---
      const reval = await deps.runRevalidation(ctx);
      outstandingFailedRevalidation = !reval.passed;

      // When revalidation fails after a fix that advanced HEAD, roll back
      // the fix commit so the next iteration starts from the pre-fix baseline
      // rather than a commit already known to break validation. This prevents
      // an exhausted loop or resumed run from inheriting unvalidated changes.
      if (!reval.passed && fix.headBeforeFix && deps.rollbackFix) {
        await deps.rollbackFix(ctx, fix.headBeforeFix);
      }

      // category-change trigger: if this revalidation failed with a different
      // category than the previous failing one, escalate the NEXT fix.
      if (!reval.passed && reval.category !== undefined) {
        if (lastFailingCategory !== undefined && lastFailingCategory !== reval.category) {
          if (input.fixFallbackProfile !== undefined) {
            consecutiveFixFailures = 2;
            this.emitEscalation(input, 'validation_category_changed');
          }
        }
        lastFailingCategory = reval.category;
      }

      // Update the unfounded-history after we know the fixer's verdict so
      // `detectUnfoundedPingPong` can see it.
      unfoundedHistory.push({
        findings: unfoundedFingerprints,
        ...(fix.verdict ? { fixerVerdict: fix.verdict } : {}),
      });

      // Short-circuit on `unfounded_pingpong`: every recent iteration had
      // unfounded findings AND the fixer rebutted every time. Escalate to
      // `needs_human_review` rather than burning the budget.
      const pingPongLimit = this.deps.unfoundedPingPongLimit ?? 4;
      const isPingPong =
        unfoundedCount > 0 &&
        fix.verdict === 'done_no_fixes_needed' &&
        detectUnfoundedPingPong(unfoundedHistory, pingPongLimit);

      if (isPingPong) {
        loop = completeIteration(loop, {
          outcome: 'failed',
          fixInvocationId: fix.invocationId,
          revalidationId: reval.validationRunId,
          now: this.deps.now(),
        });
        this.deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'failed');
        await this.appendHistoryEntry(ctx, review, fix, reval, 'failed', input);
        this.emit(
          input,
          'review.evidence.pingpong',
          'warn',
          `unfounded-pingpong detected: ${pingPongLimit} consecutive unfounded iterations`,
          {
            iterationIndex,
            unfoundedCount,
            limit: pingPongLimit,
          },
        );
        return {
          loop,
          phaseOutcome: 'failed',
          loopStatus:
            loop.status === 'converged'
              ? 'converged'
              : loop.status === 'failed'
                ? 'failed'
                : 'exhausted',
          needsHumanReview: true,
        };
      }

      // --- REBUTTAL-AWARE CONVERGENCE ---
      // If every finding was unfounded AND the fixer returned
      // `done_no_fixes_needed`, accept the rebuttal and converge.
      const findings = review.offendingFindings ?? [];
      const allUnfounded = unfoundedCount === findings.length && findings.length > 0;
      const isRebutted = allUnfounded && fix.verdict === 'done_no_fixes_needed';

      if (isRebutted) {
        // Append the rebuttal to code-review.md for human/PR-review visibility.
        if (this.deps.artifactStore) {
          const append = await appendRebuttalToCodeReview(this.deps.artifactStore, {
            runId: String(input.runId),
            phaseId: String(input.phaseId),
            iterationIndex,
            rebuttal: fix.rebuttal ?? '(no rebuttal text provided)',
            unfoundedFindings: unfoundedList,
          });
          if (!append.written) {
            this.emit(
              input,
              'review.rebuttal.append_skipped',
              'warn',
              `failed to append rebuttal to code-review.md: ${append.reason ?? 'unknown'}`,
              {
                iterationIndex,
                reason: append.reason,
              },
            );
          }
        }
        this.emit(
          input,
          'review.rebuttal.accepted',
          'info',
          `accepted fixer rebuttal: ${findings.length} unfounded findings`,
          {
            iterationIndex,
            unfoundedCount: unfoundedCount,
          },
        );
        loop = completeIteration(loop, {
          outcome: 'resolved',
          fixInvocationId: fix.invocationId,
          revalidationId: reval.validationRunId,
          now: this.deps.now(),
        });
        this.deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'resolved');
        await this.appendHistoryEntry(ctx, review, fix, reval, 'resolved', input);
        return {
          loop,
          phaseOutcome: 'passed',
          loopStatus: 'converged',
        };
      }

      // Default path: complete the iteration as fixed or unresolved.
      loop = completeIteration(loop, {
        outcome: reval.passed ? 'fixed' : 'unresolved',
        fixInvocationId: fix.invocationId,
        revalidationId: reval.validationRunId,
        now: deps.now(),
      });
      deps.loops.update(loop);
      this.emitIterationCompleted(input, iterationIndex, reval.passed ? 'fixed' : 'unresolved');

      await this.appendHistoryEntry(
        ctx,
        review,
        fix,
        reval,
        reval.passed ? 'fixed' : 'unresolved',
        input,
      );
    }

    if (loop.status === 'converged') {
      return { loop, phaseOutcome: 'passed', loopStatus: 'converged' };
    }
    if (loop.status === 'failed') {
      return { loop, phaseOutcome: 'failed', loopStatus: 'failed' };
    }
    loop = exhaust(loop, this.deps.now());
    this.deps.loops.update(loop);
    this.emit(
      input,
      'loop.exhausted',
      'error',
      `review/fix loop exhausted after ${loop.iterations.length} iterations`,
      {
        iterations: loop.iterations.length,
        maxIterations: loop.maxIterations,
      },
    );
    return { loop, phaseOutcome: 'failed', loopStatus: 'exhausted' };
  }

  private emit(
    input: ReviewFixLoopInput,
    type: string,
    level: OrchestratorEvent['level'],
    message: string,
    metadata: Record<string, unknown>,
  ): void {
    this.deps.events.publish(input.runId as unknown as string, {
      runId: input.runId as unknown as string,
      phase: input.phaseId as unknown as string,
      level,
      type,
      message,
      timestamp: this.deps.now().toISOString(),
      metadata,
    });
  }

  private emitIterationCompleted(input: ReviewFixLoopInput, index: number, outcome: string): void {
    this.emit(
      input,
      'loop.iteration.completed',
      'info',
      `iteration ${index} completed: ${outcome}`,
      {
        index,
        outcome,
      },
    );
  }

  private emitEscalation(input: ReviewFixLoopInput, triggerReason: string): void {
    const toProfile = input.fixFallbackProfile as AgentProfileName;
    this.emit(input, 'phase.fallback.escalated', 'warn', `escalating fix to ${toProfile}`, {
      fromProfile: input.fixProfile as unknown as string,
      toProfile: toProfile as unknown as string,
      triggerReason,
      triggerOwner: 'use_case',
    });
  }

  private async runCleanArtifacts(ctx: StepContext): Promise<void> {
    if (this.deps.cleanArtifacts) {
      await this.deps.cleanArtifacts(ctx);
    }
  }

  private async readHistoryContext(
    ctx: StepContext,
    audience: ReviewLoopHistoryAudience,
    input: ReviewFixLoopInput,
  ): Promise<string | undefined> {
    if (!this.deps.loopHistory) {
      return undefined;
    }
    try {
      const history = await this.deps.loopHistory.read(ctx);
      if (!history || history.length === 0) {
        return undefined;
      }
      return this.deps.loopHistory.format(history, audience);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.emit(
        input,
        'review_loop_history.read_failed',
        'warn',
        `failed to read loop history: ${errorMsg}`,
        {
          iterationIndex: ctx.iterationIndex,
          audience,
          error: errorMsg,
        },
      );
      return '';
    }
  }

  private async appendHistoryEntry(
    ctx: StepContext,
    review: ReviewStepResult,
    fix: FixStepResult | undefined,
    reval: RevalidationResult | undefined,
    outcome: ReviewLoopHistoryEntry['outcome'],
    input: ReviewFixLoopInput,
  ): Promise<void> {
    if (!this.deps.loopHistory) {
      return;
    }
    try {
      const entry: ReviewLoopHistoryEntry = {
        iteration: ctx.iterationIndex,
        review: {
          ...(review.verdict !== undefined ? { verdict: review.verdict } : {}),
          ...(review.invocationId !== undefined ? { invocationId: review.invocationId } : {}),
          ...(review.offendingFindings !== undefined
            ? { offendingFindings: review.offendingFindings }
            : {}),
          ...(review.excerpt !== undefined ? { excerpt: review.excerpt } : {}),
        },
        ...(fix
          ? {
              fix: {
                ...(fix.verdict !== undefined ? { verdict: fix.verdict } : {}),
                ...(fix.invocationId !== undefined ? { invocationId: fix.invocationId } : {}),
                ...(fix.headBeforeFix !== undefined ? { headBeforeFix: fix.headBeforeFix } : {}),
                ...(fix.summary !== undefined ? { summary: fix.summary } : {}),
              },
            }
          : {}),
        ...(reval
          ? {
              revalidation: {
                passed: reval.passed,
                ...(reval.validationRunId !== undefined
                  ? { validationRunId: reval.validationRunId }
                  : {}),
                ...(reval.category !== undefined ? { category: reval.category } : {}),
              },
            }
          : {}),
        outcome,
      };
      await this.deps.loopHistory.append(ctx, entry);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.emit(
        input,
        'review_loop_history.append_failed',
        'warn',
        `failed to append loop history: ${errorMsg}`,
        {
          iterationIndex: ctx.iterationIndex,
          outcome,
          error: errorMsg,
        },
      );
    }
  }

  /**
   * For each finding in the just-emitted reviewer verdict, run the
   * `findingEvidenceInspector` against `code-review.md`. Returns the count
   * of unfounded findings (evidence missing OR all evidence failed the
   * mechanical check). Emits a `review.evidence.unfounded` event listing
   * the unfounded findings so operators can see what was rejected.
   *
   * Returns 0 when no inspector is wired (preserves pre-#623 behavior).
   */
  private async checkReviewerEvidence(
    input: ReviewFixLoopInput,
    review: ReviewStepResult,
    iterationIndex: number,
  ): Promise<
    Array<{
      severity: string;
      summary: string;
      evidence?: { path: string; line?: number; snippet?: string };
    }>
  > {
    if (!this.deps.findingEvidenceInspector) return [];
    const findings = review.offendingFindings ?? [];
    if (findings.length === 0) return [];

    // Read code-review.md from the artifact store when available; fall back
    // to the worktree path otherwise. The artifact store is the source of
    // truth — see design §3.7.
    let markdown = '';
    if (this.deps.artifactStore) {
      try {
        markdown = await this.deps.artifactStore.read(String(input.runId), 'code-review.md');
      } catch {
        markdown = '';
      }
    }
    const evidence = extractEvidence(markdown);

    // Bucket findings. A finding is "grounded" if at least one of its
    // matching evidence pieces is confirmed by the inspector.
    const unfounded: Array<{
      severity: string;
      summary: string;
      evidence?: { path: string; line?: number; snippet?: string };
    }> = [];

    for (const f of findings) {
      const matched = evidence.filter((e) => {
        const summaryLc = f.summary.toLowerCase();
        // Heuristic: match evidence whose path appears in the summary.
        return e.path !== undefined && e.path !== '' && summaryLc.includes(e.path.toLowerCase());
      });
      if (matched.length === 0) {
        unfounded.push({ severity: f.severity, summary: f.summary });
        continue;
      }
      let anyConfirmed = false;
      for (const e of matched) {
        const result = await this.deps.findingEvidenceInspector({
          cwd: input.cwd,
          ref: 'HEAD',
          evidence: e,
        });
        if (result.evidenceConfirmed) {
          anyConfirmed = true;
          break;
        }
      }
      if (!anyConfirmed) {
        const firstMatched = matched[0];
        unfounded.push({
          severity: f.severity,
          summary: f.summary,
          ...(firstMatched ? { evidence: firstMatched } : {}),
        });
      }
    }

    if (unfounded.length > 0) {
      this.emit(
        input,
        'review.evidence.unfounded',
        'warn',
        `${unfounded.length} of ${findings.length} findings failed evidence check`,
        {
          iterationIndex,
          unfoundedCount: unfounded.length,
          totalCount: findings.length,
          unfounded: unfounded.map((u) => ({
            severity: u.severity,
            summary: u.summary,
            evidence: u.evidence ?? null,
          })),
        },
      );
    }

    return unfounded;
  }
}

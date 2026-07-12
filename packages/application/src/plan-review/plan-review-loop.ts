import {
  createLoop,
  startIteration,
  completeIteration,
  canIterate,
  exhaust,
  type Loop,
} from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type {
  PlanReviewContext,
  PlanReviewFinding,
  PlanReviewLoopDeps,
  PlanReviewLoopInput,
  PlanReviewLoopResult,
  PlanReviewStepOptions,
  PlanReviewResult,
  PlanReviewSnapshot,
} from './types.js';
import type { ReviewMode } from '../review-state/types.js';
import type { ReviewAttempt } from '../ports/review-state-repository-port.js';

export const DEFAULT_REVIEWER_MAX_RETRIES = 2;

function buildPlanReviewAttempt(params: {
  attemptId: string;
  runId: string;
  phaseId: string;
  reviewMode: ReviewMode;
  snapshot?: PlanReviewSnapshot;
  verdict?: string;
  now: () => Date;
}): ReviewAttempt {
  const { attemptId, runId, phaseId, reviewMode, snapshot, verdict, now } = params;
  const result: ReviewAttempt = {
    attemptId,
    runId,
    scope: 'plan-review',
    step: phaseId,
    reviewMode,
    dimension: 'plan',
    createdAt: now().toISOString(),
    artifacts: [],
  };
  if (snapshot) {
    result.snapshot = {
      kind: 'plan_artifact',
      identity: snapshot.planMdDigest,
      ...(snapshot.manifestDigest ? { baseIdentity: snapshot.manifestDigest } : {}),
      capturedAt: snapshot.capturedAt,
    };
  }
  if (verdict) {
    result.verdict = verdict;
  }
  return result;
}

export class PlanReviewLoop {
  constructor(private readonly deps: PlanReviewLoopDeps) {}

  async execute(input: PlanReviewLoopInput): Promise<PlanReviewLoopResult> {
    const { deps } = this;
    const reviewerMaxRetries = deps.reviewerMaxRetries ?? DEFAULT_REVIEWER_MAX_RETRIES;
    const options = { ...(deps.options ?? {}), ...(input.options ?? {}) };
    let bonusIterationUsed = false;

    let loop = createLoop({
      id: deps.idFactory(),
      runId: input.runId,
      phaseId: input.phaseId,
      type: 'plan-review',
      maxIterations: input.maxIterations,
      now: deps.now(),
    });
    deps.loops.insert(loop);

    const baseCtx: PlanReviewContext = {
      loopId: loop.id,
      runId: input.runId,
      phaseId: input.phaseId,
      repoId: input.repoId,
      cwd: input.cwd,
      iterationIndex: 1,
    };

    let pendingReconciliationContext: string | undefined;
    let frozenPrevFindings: ReadonlyArray<PlanReviewFinding> | undefined;
    let recentFixCitations: ReadonlyArray<string> = [];
    const deltaScopedReReview = options.deltaScopedReReview ?? true;
    // Per-citation disposition tracker. Keyed by `finding.citation`; updated
    // after every fix invocation based on whether the citation re-appeared
    // in the next reviewer's eligible set, whether the fixer rebutted, etc.
    // (#716, design §3.3 / §7.5). When delta scoping is enabled the loop
    // stamps each frozen finding with its current disposition when
    // threading `prevFindings` to the reviewer.
    const frozenDispositions = new Map<
      string,
      'addressed' | 'rebutted' | 'still_open' | 'never_seen_again'
    >();

    let iter1Snapshot: PlanReviewSnapshot | undefined;
    let finalFullPhase = false;
    let forceInitialFull = false;
    let preFinalFullSnapshot: PlanReviewSnapshot | undefined;

    // Resume restoration (#723): attempts persisted by an earlier process of
    // this same run mean an initial_full pass already happened. Restore the
    // latest persisted snapshot so a resumed loop starts in
    // intermediate_delta mode instead of repeating a full discovery review.
    // planMdPath is not persisted on attempts; the canonical worktree-relative
    // path is used everywhere and the prompt scope block only renders digests.
    let restoredSnapshot = false;
    if (deltaScopedReReview && deps.reviewStateRepository) {
      const priorAttempts = deps.reviewStateRepository.listAttempts(
        input.runId as string,
        'plan-review',
        input.phaseId as string,
        'plan',
      );
      const latestWithSnapshot = [...priorAttempts]
        .reverse()
        .find((a) => a.snapshot?.kind === 'plan_artifact');
      if (latestWithSnapshot?.snapshot) {
        iter1Snapshot = {
          planMdDigest: latestWithSnapshot.snapshot.identity,
          ...(latestWithSnapshot.snapshot.baseIdentity
            ? { manifestDigest: latestWithSnapshot.snapshot.baseIdentity }
            : {}),
          planMdPath: 'plan.md',
          capturedAt: latestWithSnapshot.snapshot.capturedAt,
        };
        restoredSnapshot = true;
        this.emit(
          input,
          'plan-review.snapshot.restored',
          'info',
          `restored persisted review snapshot from attempt ${latestWithSnapshot.attemptId}; resuming in intermediate_delta mode`,
          { attemptId: latestWithSnapshot.attemptId, planMdDigest: iter1Snapshot.planMdDigest },
        );
      }
    }

    let lastDeterministicMismatch: string | null = null;
    let lastDeterministicWasUnresolvedWithNoChanges = false;

    const checkAndFixManifest = async (
      currentCtx: PlanReviewContext,
    ): Promise<{ success: boolean; loop: Loop }> => {
      let localCtx = { ...currentCtx };
      while (true) {
        const manifestError = await deps.checkManifestSync(localCtx);
        if (!manifestError) {
          return { success: true, loop };
        }

        if (
          lastDeterministicMismatch === manifestError &&
          lastDeterministicWasUnresolvedWithNoChanges
        ) {
          this.emit(
            input,
            'plan-review.manifest_mismatch.suppressed',
            'warn',
            `suppressing duplicate manifest fix attempt: mismatch and state unchanged (${manifestError})`,
            { manifestError },
          );
          return { success: false, loop };
        }

        this.emit(input, 'deterministic_fix', 'warn', `manifest mismatch: ${manifestError}`, {
          diagnostic: manifestError,
        });

        if (!canIterate(loop)) {
          this.emit(
            input,
            'plan-review.manifest_mismatch.exhausted',
            'error',
            `cannot run deterministic fix: loop budget exhausted`,
            {},
          );
          return { success: false, loop };
        }

        const iterationIndex = loop.iterations.length + 1;
        this.emit(
          input,
          'plan-review.loop.iteration.started',
          'info',
          `iteration ${iterationIndex} started`,
          { index: iterationIndex },
        );

        const fix = await deps.runFix(localCtx, {
          manifestMismatch: manifestError,
          metadata: {
            iteration: iterationIndex,
            invocation_type: 'deterministic_fix',
          },
        });

        lastDeterministicMismatch = manifestError;
        lastDeterministicWasUnresolvedWithNoChanges =
          fix.agentOutcome !== 'success' ||
          fix.verdict === undefined ||
          fix.verdict === 'cannot_fix' ||
          fix.verdict === 'done_no_fixes_needed';

        recentFixCitations = deps.computeLastFixDiffCitations(localCtx.cwd, fix.headBeforeFix);

        loop = startIteration(loop, {
          kind: 'deterministic_fix',
          fixInvocationId: fix.invocationId,
          now: deps.now(),
        });

        const outcome =
          fix.agentOutcome === 'success' && fix.verdict === 'done_with_fixes'
            ? 'fixed'
            : 'unresolved';

        if (fix.verdict === 'done_no_fixes_needed') {
          this.emit(
            input,
            'plan-review.manifest_mismatch.fixer_declined',
            'warn',
            `fixer declined to address manifest/prose mismatch at iteration ${iterationIndex}; treating as unresolved`,
            { iterationIndex },
          );
        }

        loop = completeIteration(loop, {
          outcome,
          now: deps.now(),
        });
        deps.loops.update(loop);

        this.emit(
          input,
          'plan-review.loop.iteration.completed',
          'info',
          `iteration ${iterationIndex} completed: ${outcome}`,
          { index: iterationIndex, outcome },
        );

        localCtx = { ...currentCtx, iterationIndex: loop.iterations.length + 1 };
        // If the fixer returned done_no_fixes_needed or cannot_fix, we keep it unresolved but bounded
        // (meaning we return to the check loop which will find the same error and suppress the duplicate, exiting loop).
      }
    };

    const buildReviewStepOptions = (
      iterationIndex: number,
      mode: ReviewMode,
      isConfirmation: boolean = false,
    ): PlanReviewStepOptions | undefined => {
      if (!deltaScopedReReview) return undefined;
      if (mode === 'initial_full') return undefined;
      if (iterationIndex < 2 && mode !== 'final_full') return undefined;
      if (mode === 'final_full' && !isConfirmation) {
        return {
          mode,
          ...(preFinalFullSnapshot ? { snapshot: preFinalFullSnapshot } : {}),
        };
      }
      const stepOptions: PlanReviewStepOptions = {
        prevFindings: [],
        recentFixCitations: [],
        mode,
      };
      if (mode === 'intermediate_delta' && iter1Snapshot) {
        stepOptions.snapshot = iter1Snapshot;
      }
      if (frozenPrevFindings !== undefined && frozenPrevFindings.length > 0) {
        stepOptions.prevFindings = frozenPrevFindings.map((f) => ({
          ...f,
          disposition: frozenDispositions.get(f.citation) ?? 'still_open',
        }));
      }
      if (recentFixCitations.length > 0) {
        stepOptions.recentFixCitations = recentFixCitations;
      }
      if (mode === 'final_full' && isConfirmation && iter1Snapshot) {
        stepOptions.snapshot = iter1Snapshot;
      }
      return stepOptions;
    };

    while (canIterate(loop)) {
      const syncResult = await checkAndFixManifest({
        ...baseCtx,
        iterationIndex: loop.iterations.length + 1,
      });
      loop = syncResult.loop;
      if (!syncResult.success) {
        loop = exhaust(loop, deps.now());
        deps.loops.update(loop);
        return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
      }

      if (!canIterate(loop)) {
        loop = exhaust(loop, deps.now());
        deps.loops.update(loop);
        return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
      }

      const iterationIndex = loop.iterations.length + 1;
      const ctx: PlanReviewContext = { ...baseCtx, iterationIndex };

      const reviewMode: ReviewMode = finalFullPhase
        ? 'final_full'
        : (iterationIndex === 1 && !restoredSnapshot) || forceInitialFull
          ? 'initial_full'
          : 'intermediate_delta';

      if (reviewMode === 'initial_full') {
        forceInitialFull = false;
      }

      this.emit(
        input,
        'plan-review.loop.iteration.started',
        'info',
        `iteration ${iterationIndex} started`,
        {
          index: iterationIndex,
          reviewMode,
        },
      );

      // --- REVIEWER (with retry budget per parity #297) ---
      let review: PlanReviewResult | undefined;
      let reviewAttempts = 0;
      while (reviewAttempts <= reviewerMaxRetries) {
        reviewAttempts += 1;
        review = await deps.runReview(
          {
            ...ctx,
            metadata: {
              iteration: iterationIndex,
              invocation_type: reviewAttempts === 1 ? 'initial' : 'retry',
              reviewMode,
            },
          },
          buildReviewStepOptions(iterationIndex, reviewMode),
        );
        if (review.agentOutcome === 'success' && review.verdict !== undefined) break;
        if (reviewAttempts <= reviewerMaxRetries) {
          this.emit(
            input,
            'plan-review.reviewer.retry',
            'warn',
            `plan-review reviewer attempt ${reviewAttempts} failed (invocation ${review.invocationId}), retrying...`,
            {
              attempt: reviewAttempts,
              maxAttempts: reviewerMaxRetries + 1,
              agentOutcome: review.agentOutcome,
              hasVerdict: review.verdict !== undefined,
              invocationId: review.invocationId,
            },
          );
        }
      }

      if (!review || review.agentOutcome !== 'success' || review.verdict === undefined) {
        this.emit(
          input,
          'plan-review.reviewer.failed',
          'error',
          `reviewer exhausted retry budget at iteration ${iterationIndex}`,
          { iterationIndex, attempts: reviewAttempts },
        );
        loop = startIteration(loop, {
          reviewInvocationId: review?.invocationId ?? '',
          now: deps.now(),
        });
        loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(loop);
        this.emit(
          input,
          'plan-review.loop.iteration.completed',
          'info',
          `iteration ${iterationIndex} completed: failed`,
          { index: iterationIndex, outcome: 'failed' },
        );
        return { outcome: 'failed', loop, proceedWithConcerns: false };
      }

      deps.reviewStateRepository?.appendAttempt(
        buildPlanReviewAttempt({
          attemptId: review.invocationId,
          runId: input.runId as string,
          phaseId: input.phaseId as string,
          reviewMode,
          ...(review.snapshot ? { snapshot: review.snapshot } : {}),
          ...(review.verdict ? { verdict: review.verdict } : {}),
          now: deps.now,
        }),
      );

      loop = startIteration(loop, { reviewInvocationId: review.invocationId, now: deps.now() });

      if (reviewMode === 'initial_full' && review.snapshot) {
        iter1Snapshot = review.snapshot;
        this.emit(
          input,
          'plan-review.snapshot.captured',
          'info',
          `captured iteration-1 snapshot for delta-scoped passes`,
          { snapshot: iter1Snapshot },
        );
      }

      // --- EVIDENCE-BOUND GATE + OUT-OF-SCOPE DROP (#716) ---
      // When `deltaScopedReReview` is true, the loop applies the
      // evidence-bound gate to the reviewer's verdict. The gate:
      //   1. Captures the iteration-1 finding set as `frozenFindings` and
      //      stamps each entry's initial disposition as `still_open`.
      //   2. Classifies the current reviewer's findings into an "eligible"
      //      subset (grounded + either in `frozenCitations` or
      //      `recentFixCitations`); out-of-scope findings are dropped from
      //      verdict computation.
      //   3. Recomputes the verdict from the eligible set's severities
      //      so that a `p1_found` verdict with no grounded P0/P1 in scope
      //      downgrades to `p2_only` (symmetric: an under-reported verdict
      //      with grounded P0/P1 in scope escalates).
      //
      // When `deltaScopedReReview` is `false`, the gate is skipped and we
      // trust the reviewer verdict as-is. Otherwise, normalize a missing
      // findings payload to an empty set so malformed successful reviewer
      // output still flows through the same empty-set verdict
      // normalization as an explicit `[]`.
      let eligibleFindings: ReadonlyArray<PlanReviewFinding> = [];
      if (deltaScopedReReview) {
        const rawFindings = review.findings ?? [];
        if (reviewMode === 'initial_full') {
          frozenPrevFindings = rawFindings;
          for (const f of frozenPrevFindings) {
            frozenDispositions.set(f.citation, 'still_open');
          }
        }
        if (finalFullPhase) {
          eligibleFindings = rawFindings.filter((f) => f.evidence === 'grounded');
        } else {
          eligibleFindings = this.classifyFindings(
            rawFindings,
            reviewMode === 'initial_full',
            frozenPrevFindings,
            recentFixCitations,
          );
        }
        // The failure check above guarantees `review.verdict` is defined;
        // assert for the type checker.
        const adjustedVerdict = this.computeVerdict(review.verdict!, eligibleFindings);
        if (adjustedVerdict !== review.verdict) {
          this.emit(
            input,
            'plan-review.review.evidence.gate_applied',
            'info',
            `evidence-bound gate adjusted verdict from ${review.verdict} to ${adjustedVerdict} at iteration ${iterationIndex}`,
            {
              iterationIndex,
              originalVerdict: review.verdict,
              adjustedVerdict,
              ungroundedCount: rawFindings.filter((f) => f.evidence === 'ungrounded').length,
              outOfScopeCount: rawFindings.length - eligibleFindings.length,
            },
          );
        }
        // Apply the gate verdict. Compute to a local — direct reassignment
        // of `let review` here would widen the type back to
        // `PlanReviewResult | undefined`, defeating the narrowing the
        // failure check above established.
        const gatedReview: PlanReviewResult = { ...review, verdict: adjustedVerdict };
        // Replace `review` only after computing the gated value, so the
        // rest of the function continues to see a non-`undefined` type.
        review = gatedReview;
      }

      // --- ARTIFACT DIGEST DRIFT CHECK (always escalates in final_full) ---
      if (finalFullPhase) {
        if (
          review.snapshot &&
          preFinalFullSnapshot &&
          review.snapshot.planMdDigest !== preFinalFullSnapshot.planMdDigest
        ) {
          this.emit(
            input,
            'plan-review.loop.final_review.artifact_drift_detected',
            'error',
            `artifact digest drift detected in final_full review; escalating to human`,
            {
              iteration: iterationIndex,
              preFinalDigest: preFinalFullSnapshot.planMdDigest,
              finalDigest: review.snapshot.planMdDigest,
            },
          );
          loop = completeIteration(loop, { outcome: 'unresolved', now: deps.now() });
          deps.loops.update(loop);
          return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
        }
      }

      // --- RESOLUTION ON PASS / P2-ONLY ---
      if (review.verdict === 'pass' || review.verdict === 'p2_only') {
        if (finalFullPhase) {
          loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
          deps.loops.update(loop);
          this.emit(
            input,
            'plan-review.loop.iteration.completed',
            'info',
            `iteration ${iterationIndex} completed: resolved (final_full pass)`,
            { index: iterationIndex, outcome: 'resolved' },
          );
          return { outcome: 'success', loop, proceedWithConcerns: false };
        }
        if (reviewMode === 'initial_full') {
          loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
          deps.loops.update(loop);
          this.emit(
            input,
            'plan-review.loop.iteration.completed',
            'info',
            `iteration ${iterationIndex} completed: resolved`,
            { index: iterationIndex, outcome: 'resolved' },
          );
          return { outcome: 'success', loop, proceedWithConcerns: false };
        }
        if (iterationIndex === loop.maxIterations) {
          // The delta cycle converged only on the final iteration, leaving no
          // budget for the mandatory final_full verification pass. Returning
          // success here would bypass the #716 final gates — escalate instead.
          loop = completeIteration(loop, { outcome: 'unresolved', now: deps.now() });
          deps.loops.update(loop);
          this.emit(
            input,
            'plan-review.loop.final_review.skipped_budget_exhausted',
            'warn',
            `iteration ${iterationIndex} passed at max iterations without a final_full pass; escalating to human review`,
            { index: iterationIndex, outcome: 'unresolved' },
          );
          return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
        }

        const open = loop.iterations[loop.iterations.length - 1]!;
        const convergedIteration: import('@ai-sdlc/domain').LoopIteration = {
          ...open,
          reviewInvocationId: review.invocationId,
          completedAt: deps.now(),
          outcome: 'resolved',
        };
        loop = {
          ...loop,
          iterations: [...loop.iterations.slice(0, -1), convergedIteration],
          status: 'running',
        };
        deps.loops.update(loop);
        this.emit(
          input,
          'plan-review.loop.iteration.completed',
          'info',
          `iteration ${iterationIndex} completed: resolved (delta converged)`,
          { index: iterationIndex, outcome: 'resolved' },
        );

        const iterationsBeforeSync = loop.iterations.length;
        const finalSyncResult = await checkAndFixManifest({
          ...baseCtx,
          iterationIndex: loop.iterations.length + 1,
        });
        loop = finalSyncResult.loop;
        if (!finalSyncResult.success) {
          loop = exhaust(loop, deps.now());
          deps.loops.update(loop);
          return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
        }

        if (loop.iterations.length > iterationsBeforeSync) {
          finalFullPhase = false;
          preFinalFullSnapshot = undefined;
          this.emit(
            input,
            'plan-review.loop.final_review.reopened',
            'info',
            `manifest fix mutated plan during convergence; reopening delta cycle`,
            { iteration: iterationIndex },
          );
        } else {
          finalFullPhase = true;
          preFinalFullSnapshot = review.snapshot;
          this.emit(
            input,
            'plan-review.loop.final_review.started',
            'info',
            `delta converged; entering final_full review phase`,
            { iteration: iterationIndex },
          );
        }
        continue;
      }

      // --- PROCEED_WITH_CONCERNS — AC #3 ---
      if (review.verdict === 'proceed_with_concerns') {
        if (finalFullPhase) {
          loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
          deps.loops.update(loop);
          this.emit(
            input,
            'plan-review.loop.iteration.completed',
            'info',
            `iteration ${iterationIndex} completed: resolved (proceed with concerns — final_full)`,
            { index: iterationIndex, outcome: 'resolved', knownLimitations: true },
          );
          return {
            outcome: 'success',
            loop,
            proceedWithConcerns: true,
            ...(review.knownLimitations ? { knownLimitations: review.knownLimitations } : {}),
          };
        }
        if (!deltaScopedReReview) {
          loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
          deps.loops.update(loop);
          this.emit(
            input,
            'plan-review.loop.iteration.completed',
            'info',
            `iteration ${iterationIndex} completed: resolved (proceed with concerns)`,
            { index: iterationIndex, outcome: 'resolved', knownLimitations: true },
          );
          return {
            outcome: 'success',
            loop,
            proceedWithConcerns: true,
            ...(review.knownLimitations ? { knownLimitations: review.knownLimitations } : {}),
          };
        }
        if (iterationIndex === loop.maxIterations) {
          loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
          deps.loops.update(loop);
          this.emit(
            input,
            'plan-review.loop.iteration.completed',
            'info',
            `iteration ${iterationIndex} completed: resolved (proceed with concerns — max iterations reached)`,
            { index: iterationIndex, outcome: 'resolved', knownLimitations: true },
          );
          return {
            outcome: 'success',
            loop,
            proceedWithConcerns: true,
            ...(review.knownLimitations ? { knownLimitations: review.knownLimitations } : {}),
          };
        }
        const open = loop.iterations[loop.iterations.length - 1]!;
        const convergedIteration: import('@ai-sdlc/domain').LoopIteration = {
          ...open,
          reviewInvocationId: review.invocationId,
          completedAt: deps.now(),
          outcome: 'resolved',
        };
        loop = {
          ...loop,
          iterations: [...loop.iterations.slice(0, -1), convergedIteration],
          status: 'running',
        };
        deps.loops.update(loop);
        this.emit(
          input,
          'plan-review.loop.iteration.completed',
          'info',
          `iteration ${iterationIndex} completed: resolved (delta converged with concerns)`,
          { index: iterationIndex, outcome: 'resolved' },
        );
        const iterationsBeforeSync = loop.iterations.length;
        const finalSyncResult = await checkAndFixManifest({
          ...baseCtx,
          iterationIndex: loop.iterations.length + 1,
        });
        loop = finalSyncResult.loop;
        if (!finalSyncResult.success) {
          loop = exhaust(loop, deps.now());
          deps.loops.update(loop);
          return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
        }
        if (loop.iterations.length > iterationsBeforeSync) {
          finalFullPhase = false;
          preFinalFullSnapshot = undefined;
          this.emit(
            input,
            'plan-review.loop.final_review.reopened',
            'info',
            `manifest fix mutated plan during convergence with concerns; reopening delta cycle`,
            { iteration: iterationIndex },
          );
        } else {
          finalFullPhase = true;
          preFinalFullSnapshot = review.snapshot;
          this.emit(
            input,
            'plan-review.loop.final_review.started',
            'info',
            `delta converged with concerns; entering final_full review phase`,
            { iteration: iterationIndex },
          );
        }
        continue;
      }

      if (finalFullPhase && review.verdict === 'p1_found') {
        this.emit(
          input,
          'plan-review.loop.final_review.finding_reopens_cycle',
          'warn',
          `final_full review found P1; reopening delta cycle`,
          { iteration: iterationIndex },
        );
        // No iteration.completed emit here: this iteration falls through to
        // the fix step below and is completed (with its real outcome) there —
        // emitting now would produce a duplicate completion event.
        finalFullPhase = false;
        forceInitialFull = true;
        iter1Snapshot = undefined;
        frozenPrevFindings = undefined;
        frozenDispositions.clear();
        recentFixCitations = [];
      }

      // --- FIX ---
      const fix = await deps.runFix(ctx, {
        ...(pendingReconciliationContext !== undefined
          ? { reconciliationContext: pendingReconciliationContext }
          : {}),
        metadata: {
          iteration: iterationIndex,
          invocation_type: 'initial',
        },
      });
      pendingReconciliationContext = undefined;

      // Refresh the loop-internal `recentFixCitations` from the fix's
      // `headBeforeFix` SHA (#716, design §2.5 / §7.1). The composition-root
      // adapter supplies `computeLastFixDiffCitations`, which uses
      // `git diff <headBeforeFix>..HEAD -- plan.md` to compute line ranges
      // of text the fixer touched. The loop keeps the result until the next
      // fix refreshes it.
      //
      // When `headBeforeFix` is undefined (fixer failure, no fix this
      // iteration), the dep returns `[]` — the safe default. A missing
      // headBeforeFix MUST clear stale citations, not carry the previous
      // iteration's diff scope forward into the next review (#716, fix to
      // reviewer finding #1).
      recentFixCitations = deps.computeLastFixDiffCitations(ctx.cwd, fix.headBeforeFix);
      if (fix.headBeforeFix !== undefined) {
        this.emit(
          input,
          'plan-review.fix.diff_citations.refreshed',
          'info',
          `refreshed recentFixCitations at iteration ${iterationIndex} (${recentFixCitations.length} citations)`,
          {
            iterationIndex,
            headBeforeFix: fix.headBeforeFix,
            citationCount: recentFixCitations.length,
          },
        );
      } else {
        recentFixCitations = [];
      }

      if (
        fix.agentOutcome !== 'success' ||
        fix.verdict === undefined ||
        fix.verdict === 'cannot_fix'
      ) {
        loop = completeIteration(loop, {
          outcome: 'unresolved',
          fixInvocationId: fix.invocationId,
          now: deps.now(),
        });
        deps.loops.update(loop);
        this.emit(
          input,
          'plan-review.fixer.failed',
          'warn',
          `fixer could not fix findings at iteration ${iterationIndex}`,
          { iterationIndex, fixVerdict: fix.verdict, agentOutcome: fix.agentOutcome },
        );
        this.emit(
          input,
          'plan-review.loop.iteration.completed',
          'info',
          `iteration ${iterationIndex} completed: unresolved`,
          { index: iterationIndex, outcome: 'unresolved' },
        );
        continue;
      }

      // --- CONTRADICTION DETECTION ---
      const reviewFailed = review.verdict === 'p1_found';
      if (fix.verdict === 'done_no_fixes_needed' && reviewFailed) {
        this.emit(
          input,
          'plan-review.review.contradiction.detected',
          'warn',
          `review/fix contradiction at iteration ${iterationIndex}: fixer disagrees with failing review`,
          {
            iterationIndex,
            reviewVerdict: review.verdict,
            fixVerdict: fix.verdict,
            hasRebuttal: Boolean(fix.rebuttal),
          },
        );

        // --- ARBITER ESCALATION ---
        if (deps.runArbiter !== undefined) {
          this.emit(
            input,
            'plan-review.review.contradiction.escalated',
            'warn',
            `escalating review/fix contradiction to arbiter at iteration ${iterationIndex}`,
            { reason: 'contradiction', iterationIndex },
          );
          const arbiterResult = await deps.runArbiter(ctx, {
            ...fix,
            metadata: {
              iteration: iterationIndex,
              invocation_type: 'initial',
            },
          });
          if (!arbiterResult.evidence || arbiterResult.evidence.trim().length === 0) {
            this.emit(
              input,
              'plan-review.needs_human_review',
              'warn',
              `arbiter returned empty evidence at iteration ${iterationIndex} — escalating to human`,
              { iterationIndex, outcome: arbiterResult.outcome },
            );
            loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
            deps.loops.update(loop);
            return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
          }
          if (arbiterResult.outcome === 'finding_invalid') {
            this.emit(
              input,
              'plan-review.review.contradiction.resolved',
              'info',
              `arbiter resolved contradiction at iteration ${iterationIndex}: ${arbiterResult.outcome}`,
              {
                ruling: arbiterResult.outcome,
                resolvedBy: 'contradiction-arbiter',
                evidence: arbiterResult.evidence,
                iterationIndex,
              },
            );
            loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
            deps.loops.update(loop);
            return { outcome: 'success', loop, proceedWithConcerns: false };
          }
          if (arbiterResult.outcome === 'finding_valid') {
            this.emit(
              input,
              'plan-review.review.contradiction.resolved',
              'info',
              `arbiter resolved contradiction at iteration ${iterationIndex}: ${arbiterResult.outcome}`,
              { ruling: arbiterResult.outcome, evidence: arbiterResult.evidence, iterationIndex },
            );
            pendingReconciliationContext = arbiterResult.rationale;
            loop = completeIteration(loop, {
              outcome: 'unresolved',
              fixInvocationId: fix.invocationId,
              now: deps.now(),
            });
            deps.loops.update(loop);
            continue;
          }
          this.emit(
            input,
            'plan-review.needs_human_review',
            'warn',
            `arbiter could not resolve contradiction at iteration ${iterationIndex}: ${arbiterResult.outcome}`,
            { ruling: arbiterResult.outcome, evidence: arbiterResult.evidence, iterationIndex },
          );
          loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
          deps.loops.update(loop);
          return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
        }

        // No arbiter wired — escalate to human.
        this.emit(
          input,
          'plan-review.needs_human_review',
          'warn',
          `contradiction with no arbiter configured at iteration ${iterationIndex}`,
          { iterationIndex },
        );
        loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(loop);
        return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
      }

      // Update frozen-finding dispositions based on the fixer's outcome and the
      // new reviewer's eligible findings (#716, design §3.3). For each
      // frozen citation:
      //   - If the citation re-appeared in the eligible findings set, the
      //     defect is still open (`still_open`).
      //   - Else if the fixer asserted `done_no_fixes_needed`, the fixer's
      //     rebuttal stands (`rebutted`).
      //   - Otherwise the fix addressed the defect (`addressed`).
      // These dispositions are stamped onto `prevFindings` when the loop
      // threads them to the next reviewer via `buildReviewStepOptions`.
      if (deltaScopedReReview && frozenPrevFindings !== undefined) {
        for (const frozen of frozenPrevFindings) {
          const stillFlagged = eligibleFindings.some((f) => f.citation === frozen.citation);
          if (stillFlagged) {
            frozenDispositions.set(frozen.citation, 'still_open');
          } else if (fix.verdict === 'done_no_fixes_needed') {
            frozenDispositions.set(frozen.citation, 'rebutted');
          } else {
            frozenDispositions.set(frozen.citation, 'addressed');
          }
        }
      }

      loop = completeIteration(loop, {
        outcome: 'fixed',
        fixInvocationId: fix.invocationId,
        now: deps.now(), // check final review if maxIterations reached
      });
      deps.loops.update(loop);
      this.emit(
        input,
        'plan-review.loop.iteration.completed',
        'info',
        `iteration ${iterationIndex} completed: fixed`,
        { index: iterationIndex, outcome: 'fixed' },
      );

      if (iterationIndex === loop.maxIterations) {
        const syncResult = await checkAndFixManifest({
          ...baseCtx,
          iterationIndex: loop.iterations.length + 1,
        });
        loop = syncResult.loop;
        if (!syncResult.success) {
          loop = exhaust(loop, deps.now());
          deps.loops.update(loop);
          return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
        }
        const finalIterationIndex = loop.iterations.length + 1;
        const finalCtx: PlanReviewContext = { ...baseCtx, iterationIndex: finalIterationIndex };
        finalFullPhase = true;
        preFinalFullSnapshot = review.snapshot;

        this.emit(
          input,
          'plan-review.loop.final_review',
          'info',
          'Running final_full review after last fixer pass',
          { iteration: finalIterationIndex },
        );

        // --- REVIEWER (with retry budget per parity #297) ---
        let finalReview: PlanReviewResult | undefined;
        let finalReviewAttempts = 0;
        while (finalReviewAttempts <= reviewerMaxRetries) {
          finalReviewAttempts += 1;
          finalReview = await deps.runReview(
            {
              ...finalCtx,
              metadata: {
                iteration: finalIterationIndex,
                invocation_type: 'initial',
                reviewMode: 'final_full',
              },
            },
            buildReviewStepOptions(finalIterationIndex, 'final_full'),
          );
          if (finalReview.agentOutcome === 'success' && finalReview.verdict !== undefined) break;
          if (finalReviewAttempts <= reviewerMaxRetries) {
            this.emit(
              input,
              'plan-review.reviewer.retry',
              'warn',
              `plan-review reviewer attempt ${finalReviewAttempts} failed (invocation ${finalReview.invocationId}), retrying...`,
              {
                attempt: finalReviewAttempts,
                maxAttempts: reviewerMaxRetries + 1,
                agentOutcome: finalReview.agentOutcome,
                hasVerdict: finalReview.verdict !== undefined,
                invocationId: finalReview.invocationId,
              },
            );
          }
        }

        if (
          !finalReview ||
          finalReview.agentOutcome !== 'success' ||
          finalReview.verdict === undefined
        ) {
          this.emit(
            input,
            'plan-review.reviewer.failed',
            'error',
            `reviewer exhausted retry budget at final review pass`,
            { iterationIndex: finalIterationIndex, attempts: finalReviewAttempts },
          );
          loop = {
            ...loop,
            iterations: [
              ...loop.iterations,
              {
                index: finalIterationIndex,
                reviewInvocationId: finalReview?.invocationId ?? '',
                startedAt: deps.now(),
                completedAt: deps.now(),
                outcome: 'failed',
              },
            ],
          };
          loop = exhaust(loop, deps.now());
          deps.loops.update(loop);
          this.emit(
            input,
            'plan-review.loop.iteration.completed',
            'info',
            `iteration ${finalIterationIndex} completed: failed`,
            { index: finalIterationIndex, outcome: 'failed' },
          );
          return { outcome: 'failed', loop, proceedWithConcerns: false };
        }

        deps.reviewStateRepository?.appendAttempt(
          buildPlanReviewAttempt({
            attemptId: finalReview.invocationId,
            runId: input.runId as string,
            phaseId: input.phaseId as string,
            reviewMode: 'final_full',
            ...(finalReview.snapshot ? { snapshot: finalReview.snapshot } : {}),
            ...(finalReview.verdict ? { verdict: finalReview.verdict } : {}),
            now: deps.now,
          }),
        );

        if (
          finalReview.snapshot &&
          preFinalFullSnapshot &&
          finalReview.snapshot.planMdDigest !== preFinalFullSnapshot.planMdDigest
        ) {
          this.emit(
            input,
            'plan-review.loop.final_review.artifact_drift_detected',
            'error',
            `artifact digest drift detected in final_full review; escalating to human`,
            {
              iteration: finalIterationIndex,
              preFinalDigest: preFinalFullSnapshot.planMdDigest,
              finalDigest: finalReview.snapshot.planMdDigest,
            },
          );
          const finalIteration: import('@ai-sdlc/domain').LoopIteration = {
            index: finalIterationIndex,
            reviewInvocationId: finalReview.invocationId,
            startedAt: deps.now(),
            completedAt: deps.now(),
            outcome: 'unresolved',
          };
          loop = {
            ...loop,
            iterations: [...loop.iterations, finalIteration],
          };
          loop = exhaust(loop, deps.now());
          deps.loops.update(loop);
          return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
        }

        if (finalReview.verdict === 'pass' || finalReview.verdict === 'p2_only') {
          const finalIteration: import('@ai-sdlc/domain').LoopIteration = {
            index: finalIterationIndex,
            reviewInvocationId: finalReview.invocationId,
            startedAt: deps.now(),
            completedAt: deps.now(),
            outcome: 'resolved',
          };
          loop = {
            ...loop,
            iterations: [...loop.iterations, finalIteration],
            status: 'converged',
            completedAt: deps.now(),
          };
          deps.loops.update(loop);
          this.emit(
            input,
            'plan-review.loop.iteration.completed',
            'info',
            `iteration ${finalIterationIndex} completed: resolved`,
            { index: finalIterationIndex, outcome: 'resolved' },
          );
          return { outcome: 'success', loop, proceedWithConcerns: false };
        }

        if (finalReview.verdict === 'proceed_with_concerns') {
          const finalIteration: import('@ai-sdlc/domain').LoopIteration = {
            index: finalIterationIndex,
            reviewInvocationId: finalReview.invocationId,
            startedAt: deps.now(),
            completedAt: deps.now(),
            outcome: 'resolved',
          };
          loop = {
            ...loop,
            iterations: [...loop.iterations, finalIteration],
            status: 'converged',
            completedAt: deps.now(),
          };
          deps.loops.update(loop);
          this.emit(
            input,
            'plan-review.loop.iteration.completed',
            'info',
            `iteration ${finalIterationIndex} completed: resolved (proceed with concerns)`,
            { index: finalIterationIndex, outcome: 'resolved', knownLimitations: true },
          );
          return {
            outcome: 'success',
            loop,
            proceedWithConcerns: true,
            ...(finalReview.knownLimitations
              ? { knownLimitations: finalReview.knownLimitations }
              : {}),
          };
        }

        if (deps.runFinalReviewArbiter !== undefined) {
          this.emit(
            input,
            'plan-review.final_review.arbiter.escalated',
            'warn',
            `escalating final review fail to arbiter at iteration ${finalIterationIndex}`,
            { reason: 'final_review_fail', iterationIndex: finalIterationIndex },
          );
          const arbiterResult = await deps.runFinalReviewArbiter(finalCtx, {
            ...finalReview,
            metadata: {
              iteration: finalIterationIndex,
              invocation_type: 'initial',
            },
          });
          if (!arbiterResult.evidence || arbiterResult.evidence.trim().length === 0) {
            this.emit(
              input,
              'plan-review.needs_human_review',
              'warn',
              `final review arbiter returned empty evidence at iteration ${finalIterationIndex} — escalating to human`,
              { iterationIndex: finalIterationIndex, outcome: arbiterResult.outcome },
            );
            const finalIteration: import('@ai-sdlc/domain').LoopIteration = {
              index: finalIterationIndex,
              reviewInvocationId: finalReview.invocationId,
              startedAt: deps.now(),
              completedAt: deps.now(),
              // 'failed' covers both "fixer failed" and "arbiter returned empty evidence"
              // (G1 guardrail). Consumers should use the iteration event metadata to
              // distinguish the two when needed.
              outcome: 'failed',
            };
            loop = {
              ...loop,
              iterations: [...loop.iterations, finalIteration],
            };
            this.emit(
              input,
              'plan-review.loop.iteration.completed',
              'info',
              `iteration ${finalIterationIndex} completed: failed`,
              { index: finalIterationIndex, outcome: 'failed' },
            );
            loop = exhaust(loop, deps.now());
            deps.loops.update(loop);
            return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
          }
          if (arbiterResult.outcome === 'finding_invalid') {
            this.emit(
              input,
              'plan-review.final_review.arbiter.resolved',
              'info',
              `arbiter resolved final review fail at iteration ${finalIterationIndex}: ${arbiterResult.outcome}`,
              {
                ruling: arbiterResult.outcome,
                resolvedBy: 'final-review-arbiter',
                evidence: arbiterResult.evidence,
                iterationIndex: finalIterationIndex,
              },
            );
            const finalIteration: import('@ai-sdlc/domain').LoopIteration = {
              index: finalIterationIndex,
              reviewInvocationId: finalReview.invocationId,
              startedAt: deps.now(),
              completedAt: deps.now(),
              outcome: 'resolved',
            };
            loop = {
              ...loop,
              iterations: [...loop.iterations, finalIteration],
              status: 'converged',
              completedAt: deps.now(),
            };
            deps.loops.update(loop);
            this.emit(
              input,
              'plan-review.loop.iteration.completed',
              'info',
              `iteration ${finalIterationIndex} completed: resolved`,
              {
                index: finalIterationIndex,
                outcome: 'resolved',
                resolvedBy: 'final-review-arbiter',
              },
            );
            return {
              outcome: 'success',
              loop,
              proceedWithConcerns: false,
              ...(finalReview.knownLimitations
                ? { knownLimitations: finalReview.knownLimitations }
                : {}),
            };
          } else if (
            arbiterResult.outcome === 'finding_valid' &&
            !bonusIterationUsed &&
            options.bonusIteration !== false
          ) {
            this.emit(
              input,
              'plan-review.loop.trailing_review.bonus_fix_iteration',
              'info',
              `granting one-time bonus fix iteration for valid trailing finding at iteration ${finalIterationIndex}`,
              { iterationIndex: finalIterationIndex, rationale: arbiterResult.rationale },
            );
            bonusIterationUsed = true;

            // Fix to reviewer finding #3: the trailing finding that triggered
            // this bonus iteration must be added to scope so the confirmation
            // pass (Step 8) actually verifies it, not just the iteration-1
            // frozen findings. Without this, the confirmation review has no
            // record of what it is meant to confirm and can drift onto
            // unrelated new findings instead. This is exactly how the bonus
            // mechanism silently wasted its one shot on run `b8f66cc4`
            // (issue #693): the confirmation review found unrelated new
            // issues instead of checking the trigger.
            if (deltaScopedReReview) {
              const triggeringFindings = finalReview.findings ?? [];
              for (const f of triggeringFindings) {
                if (frozenPrevFindings === undefined) {
                  frozenPrevFindings = [f];
                } else if (!frozenPrevFindings.some((ff) => ff.citation === f.citation)) {
                  frozenPrevFindings = [...frozenPrevFindings, f];
                }
                frozenDispositions.set(f.citation, 'still_open');
              }
            }

            // 1. Bonus Fix
            const bonusFix = await deps.runFix(finalCtx, {
              reconciliationContext: arbiterResult.rationale,
              metadata: {
                iteration: finalIterationIndex,
                invocation_type: 'initial',
              },
            });
            recentFixCitations = deps.computeLastFixDiffCitations(
              finalCtx.cwd,
              bonusFix.headBeforeFix,
            );

            const fixIteration: import('@ai-sdlc/domain').LoopIteration = {
              index: finalIterationIndex,
              reviewInvocationId: finalReview.invocationId,
              fixInvocationId: bonusFix.invocationId,
              startedAt: deps.now(),
              completedAt: deps.now(),
              outcome:
                bonusFix.agentOutcome === 'success' && bonusFix.verdict === 'done_with_fixes'
                  ? 'fixed'
                  : 'unresolved',
            };
            loop = {
              ...loop,
              iterations: [...loop.iterations, fixIteration],
            };
            deps.loops.update(loop);

            if (fixIteration.outcome === 'fixed') {
              // 2. Confirmation Review
              const syncResult = await checkAndFixManifest({
                ...baseCtx,
                iterationIndex: loop.iterations.length + 1,
              });
              loop = syncResult.loop;
              if (!syncResult.success) {
                loop = exhaust(loop, deps.now());
                deps.loops.update(loop);
                return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
              }
              const confirmIterationIndex = loop.iterations.length + 1;
              const confirmCtx: PlanReviewContext = {
                ...baseCtx,
                iterationIndex: confirmIterationIndex,
              };

              this.emit(
                input,
                'plan-review.loop.final_review',
                'info',
                'Running confirmation review after bonus fixer pass',
                { iteration: confirmIterationIndex },
              );

              let confirmReview: PlanReviewResult | undefined;
              let confirmAttempts = 0;
              while (confirmAttempts <= reviewerMaxRetries) {
                confirmAttempts += 1;
                confirmReview = await deps.runReview(
                  {
                    ...confirmCtx,
                    metadata: {
                      iteration: confirmIterationIndex,
                      invocation_type: confirmAttempts === 1 ? 'initial' : 'retry',
                    },
                  },
                  buildReviewStepOptions(confirmIterationIndex, 'final_full', true),
                );
                if (confirmReview.agentOutcome === 'success' && confirmReview.verdict !== undefined)
                  break;
                if (confirmAttempts <= reviewerMaxRetries) {
                  this.emit(
                    input,
                    'plan-review.reviewer.retry',
                    'warn',
                    `plan-review confirmation reviewer attempt ${confirmAttempts} failed, retrying...`,
                    { attempt: confirmAttempts, iterationIndex: confirmIterationIndex },
                  );
                }
              }

              if (
                confirmReview?.agentOutcome === 'success' &&
                confirmReview.verdict !== undefined
              ) {
                deps.reviewStateRepository?.appendAttempt(
                  buildPlanReviewAttempt({
                    attemptId: confirmReview.invocationId,
                    runId: input.runId as string,
                    phaseId: input.phaseId as string,
                    reviewMode: 'final_full',
                    ...(confirmReview.snapshot ? { snapshot: confirmReview.snapshot } : {}),
                    ...(confirmReview.verdict ? { verdict: confirmReview.verdict } : {}),
                    now: deps.now,
                  }),
                );
                if (
                  confirmReview.verdict === 'pass' ||
                  confirmReview.verdict === 'p2_only' ||
                  confirmReview.verdict === 'proceed_with_concerns'
                ) {
                  const confirmIteration: import('@ai-sdlc/domain').LoopIteration = {
                    index: confirmIterationIndex,
                    reviewInvocationId: confirmReview.invocationId,
                    startedAt: deps.now(),
                    completedAt: deps.now(),
                    outcome: 'resolved',
                  };
                  loop = {
                    ...loop,
                    iterations: [...loop.iterations, confirmIteration],
                    status: 'converged',
                    completedAt: deps.now(),
                  };
                  deps.loops.update(loop);
                  return {
                    outcome: 'success',
                    loop,
                    proceedWithConcerns: confirmReview.verdict === 'proceed_with_concerns',
                    ...(confirmReview.knownLimitations
                      ? { knownLimitations: confirmReview.knownLimitations }
                      : {}),
                  };
                }

                // Confirm review failed
                const confirmIteration: import('@ai-sdlc/domain').LoopIteration = {
                  index: confirmIterationIndex,
                  reviewInvocationId: confirmReview.invocationId,
                  startedAt: deps.now(),
                  completedAt: deps.now(),
                  outcome: 'unresolved',
                };
                loop = { ...loop, iterations: [...loop.iterations, confirmIteration] };
              } else {
                // Confirm review agent failure
                const confirmIteration: import('@ai-sdlc/domain').LoopIteration = {
                  index: confirmIterationIndex,
                  reviewInvocationId: confirmReview?.invocationId ?? '',
                  startedAt: deps.now(),
                  completedAt: deps.now(),
                  outcome: 'failed',
                };
                loop = { ...loop, iterations: [...loop.iterations, confirmIteration] };
              }
            }

            loop = exhaust(loop, deps.now());
            deps.loops.update(loop);
            return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
          } else {
            this.emit(
              input,
              'plan-review.final_review.arbiter.resolved',
              'info',
              `arbiter could not resolve final review fail at iteration ${finalIterationIndex}: ${arbiterResult.outcome}`,
              {
                ruling: arbiterResult.outcome,
                evidence: arbiterResult.evidence,
                iterationIndex: finalIterationIndex,
              },
            );
          }
        }

        const finalIteration: import('@ai-sdlc/domain').LoopIteration = {
          index: finalIterationIndex,
          reviewInvocationId: finalReview.invocationId,
          startedAt: deps.now(),
          completedAt: deps.now(),
          outcome: 'unresolved',
        };
        loop = {
          ...loop,
          iterations: [...loop.iterations, finalIteration],
        };
        deps.loops.update(loop);
        this.emit(
          input,
          'plan-review.loop.iteration.completed',
          'info',
          `iteration ${finalIterationIndex} completed: unresolved`,
          { index: finalIterationIndex, outcome: 'unresolved' },
        );
      }
    }

    loop = exhaust(loop, deps.now());
    deps.loops.update(loop);
    this.emit(
      input,
      'plan-review.loop.exhausted',
      'error',
      `plan-review loop exhausted after ${loop.iterations.length} iterations`,
      { iterations: loop.iterations.length, maxIterations: loop.maxIterations },
    );
    return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
  }

  private emit(
    input: PlanReviewLoopInput,
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

  /**
   * Classify the reviewer's raw findings into the subset eligible to
   * contribute to the loop's verdict computation (#716, design §3.2).
   *
   * A finding is eligible when ALL of:
   *   - Its `evidence` is `grounded` (the citation resolved against the
   *     artifact store). Ungrounded findings cannot drive `p1_found`.
   *   - On iteration 1 (discovery pass), this is the only criterion — every
   *     grounded finding is eligible because there is no prior scope yet.
   *   - On iteration >= 2, the finding must EITHER re-flag a frozen
   *     finding from iteration 1 (`frozenCitations`), OR cite text the
   *     most recent fix invocation actually modified (`recentSet`).
   *     Findings outside both sets are out-of-scope: brand-new findings
   *     about pre-existing plan prose that the fixer did not touch.
   *     These are dropped from verdict computation (the loop never asks
   *     the reviewer to retract them — it just refuses to let them
   *     re-open a converged iteration).
   */
  private classifyFindings(
    raw: ReadonlyArray<PlanReviewFinding>,
    isInitialFull: boolean,
    frozenFindings: ReadonlyArray<PlanReviewFinding> | undefined,
    recentFixCitations: ReadonlyArray<string>,
  ): ReadonlyArray<PlanReviewFinding> {
    if (isInitialFull) {
      // Discovery pass: every grounded finding is eligible.
      return raw.filter((f) => f.evidence === 'grounded');
    }
    const frozenCitations = new Set((frozenFindings ?? []).map((f) => f.citation));
    const recentSet = new Set(recentFixCitations);
    const eligible: PlanReviewFinding[] = [];
    for (const f of raw) {
      if (f.evidence !== 'grounded') {
        // Schema-level or resolver-rejected finding: never eligible.
        continue;
      }
      if (frozenCitations.has(f.citation)) {
        // A frozen finding re-flagged: eligible (still_open path).
        eligible.push(f);
        continue;
      }
      if (recentSet.has(f.citation)) {
        // A new finding targeting text the most recent fix touched.
        eligible.push(f);
        continue;
      }
      // Out of scope: drop from verdict computation.
    }
    return eligible;
  }

  /**
   * Recompute the verdict from the eligible findings set (#716, design
   * §3.2). Symmetric: an under-reported verdict with grounded P0/P1 in
   * scope escalates; an over-reported verdict with no eligible P0/P1
   * downgrades.
   *
   * The rules:
   *   - If the eligible set contains a grounded P0 or P1, the verdict
   *     must reflect a blocking finding. `p1_found` stays `p1_found`.
   *     `proceed_with_concerns` upgrades to `p1_found` if any eligible
   *     P1 is present, otherwise to `p2_only` (P0 absence makes the P1
   *     "no longer applicable" — the reviewer reported it without a P0
   *     "this is the most serious defect" anchor, so the verdict moves
   *     from `proceed_with_concerns` → `p2_only`).
   *   - If the eligible set has no grounded P0/P1, any verdict that
   *     signaled blocking (`p1_found`, `proceed_with_concerns`) is
   *     downgraded to `p2_only` because every P0/P1 was either
   *     ungrounded (citation didn't resolve) or out-of-scope (cites
   *     pre-existing prose the fixer did not touch).
   *
   * Caller MUST guarantee `reviewerVerdict` is defined; this is enforced
   * by the gate's call site (the loop's failure check above has already
   * rejected undefined verdicts). Returning the defined-only subset here
   * keeps the gate's spread assignable to `PlanReviewResult` without
   * forcing `exactOptionalPropertyTypes: true` plumbing.
   */
  private computeVerdict(
    reviewerVerdict: NonNullable<PlanReviewResult['verdict']>,
    eligible: ReadonlyArray<PlanReviewFinding>,
  ): NonNullable<PlanReviewResult['verdict']> {
    const hasP0 = eligible.some((f) => f.severity === 'P0');
    const hasP1 = eligible.some((f) => f.severity === 'P1');
    if (hasP0) return 'p1_found';
    if (hasP1) return 'p1_found';

    if (reviewerVerdict === 'p1_found' || reviewerVerdict === 'proceed_with_concerns') {
      return 'p2_only';
    }
    return reviewerVerdict;
  }
}

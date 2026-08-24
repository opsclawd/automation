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
  PlanReviewArbiterResult,
} from './types.js';
import type { ReviewMode } from '../review-state/types.js';
import type { ReviewAttempt } from '../ports/review-state-repository-port.js';
import { parseGitStatusPaths } from '../artifacts/orchestrator-artifacts.js';
import { verifyPlanReviewArbiterGrounding } from './arbiter-grounding.js';

export const DEFAULT_REVIEWER_MAX_RETRIES = 2;

type GuardedReviewResult = { ok: true; review: PlanReviewResult } | { ok: false };

type GuardedArbiterResult = { ok: true; result: PlanReviewArbiterResult } | { ok: false };

function normalizeWorktreePath(p: string): string {
  let normalized = p.trim().replace(/\\/g, '/');
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  if (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

function isPermittedStatusPath(rawPath: string, permittedPaths: ReadonlyArray<string>): boolean {
  const normalized = normalizeWorktreePath(rawPath);
  return permittedPaths.includes(normalized);
}

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

interface HistoryItem {
  type: 'review' | 'fix' | 'arbiter' | 'deterministic_check';
  iterationIndex: number;
  data: Record<string, unknown>;
}

function formatHistory(history: HistoryItem[]): string {
  let lines: string[] = ['### Plan Review Loop History\n'];
  for (const item of history) {
    lines.push(`#### Iteration ${item.iterationIndex}: ${item.type.toUpperCase()}`);
    if (item.type === 'review') {
      lines.push(`- Mode: ${item.data.mode}`);
      const findings = item.data.findings as PlanReviewFinding[];
      if (!findings || findings.length === 0) {
        lines.push('- No findings.');
      } else {
        lines.push('- Findings:');
        for (const f of findings) {
          lines.push(
            `  * [${f.severity}] ${f.citation}: ${f.failureScenario} (evidence: ${f.evidence}, disposition: ${f.disposition})`,
          );
        }
      }
    } else if (item.type === 'fix') {
      if (item.data.isDeterministicFix) {
        lines.push(`- Deterministic Plan Fix`);
      }
      lines.push(`- Verdict: ${item.data.verdict}`);
      if (item.data.summary) lines.push(`- Summary: ${item.data.summary}`);
      if (item.data.rebuttal) lines.push(`- Rebuttal: ${item.data.rebuttal}`);
    } else if (item.type === 'arbiter') {
      lines.push(`- Review Type: ${item.data.reviewType}`);
      lines.push(`- Outcome: ${item.data.outcome}`);
      if (item.data.evidence) lines.push(`- Evidence: ${item.data.evidence}`);
      if (item.data.rationale) lines.push(`- Rationale: ${item.data.rationale}`);
    } else if (item.type === 'deterministic_check') {
      lines.push(`- Deterministic Diagnostic: ${item.data.diagnostic}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export class PlanReviewLoop {
  constructor(private readonly deps: PlanReviewLoopDeps) {}

  async execute(input: PlanReviewLoopInput): Promise<PlanReviewLoopResult> {
    const { deps } = this;
    const history: HistoryItem[] = [];
    const reviewerMaxRetries = deps.reviewerMaxRetries ?? DEFAULT_REVIEWER_MAX_RETRIES;
    const options = { ...(deps.options ?? {}), ...(input.options ?? {}) };
    let bonusIterationUsed = false;
    let finalFullGrantUsed = false;
    let pendingPostReopenVerification = false;
    let postReopenVerificationUsed = false;

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

    let lastDeterministicDiagnostic: string | null = null;
    let lastDeterministicWasUnresolvedWithNoChanges = false;
    let consecutiveIdenticalDiagnosticCount = 0;
    let lastReview: PlanReviewResult | undefined;
    let arbiterAlreadyRuledValid = false;

    const checkAndFixDeterministic = async (
      currentCtx: PlanReviewContext,
    ): Promise<{ success: boolean; loop: Loop }> => {
      let localCtx = { ...currentCtx };
      while (true) {
        const checkResult = await deps.checkDeterministicPlan(localCtx);
        if (!checkResult.diagnostic) {
          return { success: true, loop };
        }

        if (checkResult.diagnostic === lastDeterministicDiagnostic) {
          consecutiveIdenticalDiagnosticCount += 1;
        } else {
          consecutiveIdenticalDiagnosticCount = 1;
        }

        if (consecutiveIdenticalDiagnosticCount >= 3) {
          this.emit(
            input,
            'plan-review.deterministic_check.short_circuited',
            'warn',
            `this deterministic check cannot be satisfied by iterative fixing — likely an additive-change false positive: ${checkResult.diagnostic}`,
            { diagnostic: checkResult.diagnostic },
          );
          return { success: false, loop };
        }

        if (
          lastDeterministicDiagnostic === checkResult.diagnostic &&
          lastDeterministicWasUnresolvedWithNoChanges
        ) {
          this.emit(
            input,
            'plan-review.deterministic_check.suppressed',
            'warn',
            `suppressing duplicate deterministic fix attempt: diagnostic and state unchanged (${checkResult.diagnostic})`,
            { diagnostic: checkResult.diagnostic },
          );
          return { success: false, loop };
        }

        for (const failure of checkResult.signatureBlastRadiusFailures) {
          this.emit(
            input,
            'plan-review.signature_blast_radius.failed',
            'warn',
            `signature blast radius check failed for task ${failure.taskN} symbol ${failure.symbol}`,
            {
              taskN: failure.taskN,
              symbol: failure.symbol,
              uncoveredFileCount: failure.uncoveredReferences.length,
            },
          );
        }

        this.emit(
          input,
          'deterministic_fix',
          'warn',
          `deterministic check failed: ${checkResult.diagnostic}`,
          {
            diagnostic: checkResult.diagnostic,
            signatureBlastRadiusFailureCount: checkResult.signatureBlastRadiusFailures.length,
          },
        );

        if (!canIterate(loop)) {
          this.emit(
            input,
            'plan-review.deterministic_check.exhausted',
            'error',
            `cannot run deterministic fix: loop budget exhausted`,
            {},
          );
          lastDeterministicDiagnostic = checkResult.diagnostic;
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

        history.push({
          type: 'deterministic_check',
          iterationIndex,
          data: { diagnostic: checkResult.diagnostic },
        });

        const fix = await deps.runFix(localCtx, {
          deterministicDiagnostic: checkResult.diagnostic,
          metadata: {
            iteration: iterationIndex,
            invocation_type: 'deterministic_fix',
          },
        });

        history.push({
          type: 'fix',
          iterationIndex,
          data: {
            verdict: fix.verdict,
            summary: fix.summary,
            rebuttal: fix.rebuttal,
            isDeterministicFix: true,
          },
        });

        lastDeterministicDiagnostic = checkResult.diagnostic;
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
            'plan-review.deterministic_check.fixer_declined',
            'warn',
            `fixer declined to address deterministic check failure at iteration ${iterationIndex}; treating as unresolved`,
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
      const syncResult = await checkAndFixDeterministic({
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

      let review: PlanReviewResult | undefined;
      const skippingRedundantReview =
        pendingReconciliationContext !== undefined && lastReview !== undefined;

      if (skippingRedundantReview) {
        review = lastReview;
        loop = startIteration(loop, {
          reviewInvocationId: review?.invocationId ?? '',
          now: deps.now(),
        });
        this.emit(
          input,
          'plan-review.review.bypassed_for_arbitration',
          'info',
          `bypassing redundant re-review at iteration ${iterationIndex} to route arbiter rationale directly to fix step`,
          { iterationIndex },
        );
      } else {
        arbiterAlreadyRuledValid = false;
        // --- REVIEWER (with retry budget per parity #297) ---
        let reviewAttempts = 0;
        while (reviewAttempts <= reviewerMaxRetries) {
          reviewAttempts += 1;
          const guardedResult = await this.runGuardedReview(
            input,
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
          if (!guardedResult.ok) {
            loop = startIteration(loop, {
              reviewInvocationId: '',
              now: deps.now(),
            });
            loop = completeIteration(loop, { outcome: 'unresolved', now: deps.now() });
            loop = exhaust(loop, deps.now());
            deps.loops.update(loop);
            return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
          }
          review = guardedResult.review;
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

        lastReview = review;

        history.push({
          type: 'review',
          iterationIndex,
          data: {
            mode: reviewMode,
            findings: (review.findings ?? []).map((f) => ({
              severity: f.severity,
              citation: f.citation,
              failureScenario: f.failureScenario,
              evidence: f.evidence,
              disposition: frozenDispositions.get(f.citation) ?? 'still_open',
            })),
          },
        });

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
      }

      if (!review) {
        return { outcome: 'failed', loop, proceedWithConcerns: false };
      }
      let activeReview: PlanReviewResult = review;

      if (reviewMode === 'initial_full') {
        iter1Snapshot = activeReview.snapshot ?? (await deps.captureSnapshot(ctx));
        if (iter1Snapshot) {
          this.emit(
            input,
            'plan-review.snapshot.captured',
            'info',
            `captured iteration-1 snapshot for delta-scoped passes`,
            { snapshot: iter1Snapshot },
          );
        }
      }

      // --- EVIDENCE-BOUND GATE + OUT-OF-SCOPE DROP (#716) ---
      let eligibleFindings: ReadonlyArray<PlanReviewFinding> = [];
      let isGateManufactured = false;
      if (deltaScopedReReview) {
        const rawFindings = activeReview.findings ?? [];
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
        const adjustedVerdict = this.computeVerdict(activeReview.verdict!, eligibleFindings);
        isGateManufactured = activeReview.verdict === 'pass' && adjustedVerdict === 'p1_found';
        if (adjustedVerdict !== activeReview.verdict) {
          this.emit(
            input,
            'plan-review.review.evidence.gate_applied',
            'info',
            `evidence-bound gate adjusted verdict from ${activeReview.verdict} to ${adjustedVerdict} at iteration ${iterationIndex}`,
            {
              iterationIndex,
              originalVerdict: activeReview.verdict,
              adjustedVerdict,
              ungroundedCount: rawFindings.filter((f) => f.evidence === 'ungrounded').length,
              outOfScopeCount: rawFindings.length - eligibleFindings.length,
            },
          );
        }
        const gatedReview: PlanReviewResult = {
          ...activeReview,
          verdict: adjustedVerdict,
          invocationId: activeReview.invocationId,
        };
        activeReview = gatedReview;
      }

      // --- ARTIFACT DIGEST DRIFT CHECK (always escalates in final_full) ---
      if (finalFullPhase) {
        if (
          activeReview.snapshot &&
          preFinalFullSnapshot &&
          activeReview.snapshot.planMdDigest !== preFinalFullSnapshot.planMdDigest
        ) {
          this.emit(
            input,
            'plan-review.loop.final_review.artifact_drift_detected',
            'error',
            `artifact digest drift detected in final_full review; escalating to human`,
            {
              iteration: iterationIndex,
              preFinalDigest: preFinalFullSnapshot.planMdDigest,
              finalDigest: activeReview.snapshot.planMdDigest,
            },
          );
          loop = completeIteration(loop, { outcome: 'unresolved', now: deps.now() });
          deps.loops.update(loop);
          return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
        }
      }

      // --- RESOLUTION ON PASS / P2-ONLY ---
      if (activeReview.verdict === 'pass' || activeReview.verdict === 'p2_only') {
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
          if (!finalFullGrantUsed) {
            finalFullGrantUsed = true;
            loop.maxIterations += 1;
            this.emit(
              input,
              'plan-review.loop.final_review.budget_extended',
              'info',
              `iteration ${iterationIndex} passed at max iterations; granting one additional iteration for mandatory final_full pass`,
              { index: iterationIndex, maxIterations: loop.maxIterations },
            );
          } else {
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
        }

        const open = loop.iterations[loop.iterations.length - 1]!;
        const convergedIteration: import('@ai-sdlc/domain').LoopIteration = {
          ...open,
          reviewInvocationId: activeReview.invocationId,
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
        const finalSyncResult = await checkAndFixDeterministic({
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
          preFinalFullSnapshot = activeReview.snapshot;
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
      if (activeReview.verdict === 'proceed_with_concerns') {
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
            ...(activeReview.knownLimitations
              ? { knownLimitations: activeReview.knownLimitations }
              : {}),
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
            ...(activeReview.knownLimitations
              ? { knownLimitations: activeReview.knownLimitations }
              : {}),
          };
        }
        if (iterationIndex === loop.maxIterations) {
          if (!finalFullGrantUsed) {
            finalFullGrantUsed = true;
            loop.maxIterations += 1;
            this.emit(
              input,
              'plan-review.loop.final_review.budget_extended',
              'info',
              `iteration ${iterationIndex} converged with concerns at max iterations; granting one additional iteration for mandatory final_full pass`,
              { index: iterationIndex, maxIterations: loop.maxIterations },
            );
          } else {
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
              ...(activeReview.knownLimitations
                ? { knownLimitations: activeReview.knownLimitations }
                : {}),
            };
          }
        }
        const open = loop.iterations[loop.iterations.length - 1]!;
        const convergedIteration: import('@ai-sdlc/domain').LoopIteration = {
          ...open,
          reviewInvocationId: activeReview.invocationId,
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
        const finalSyncResult = await checkAndFixDeterministic({
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
          preFinalFullSnapshot = activeReview.snapshot;
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

      if (finalFullPhase && activeReview.verdict === 'p1_found') {
        pendingPostReopenVerification = finalFullGrantUsed;
        this.emit(
          input,
          'plan-review.loop.final_review.finding_reopens_cycle',
          'warn',
          `final_full review found P1; reopening delta cycle`,
          { iteration: iterationIndex },
        );
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

      history.push({
        type: 'fix',
        iterationIndex,
        data: {
          verdict: fix.verdict,
          summary: fix.summary,
          rebuttal: fix.rebuttal,
        },
      });

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
        pendingPostReopenVerification = false;
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
      const reviewFailed = activeReview.verdict === 'p1_found';
      if (fix.verdict === 'done_no_fixes_needed' && reviewFailed) {
        pendingPostReopenVerification = false;
        this.emit(
          input,
          'plan-review.review.contradiction.detected',
          'warn',
          `review/fix contradiction at iteration ${iterationIndex}: fixer disagrees with failing review`,
          {
            iterationIndex,
            reviewVerdict: review?.verdict,
            fixVerdict: fix.verdict,
            hasRebuttal: Boolean(fix.rebuttal),
          },
        );

        if (arbiterAlreadyRuledValid) {
          this.emit(
            input,
            'plan-review.needs_human_review',
            'warn',
            `fixer declined to fix finding at iteration ${iterationIndex} despite prior arbiter ruling finding_valid — escalating to human`,
            { iterationIndex },
          );
          loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
          deps.loops.update(loop);
          return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
        }

        // --- ARBITER ESCALATION ---
        if (deps.runArbiter !== undefined) {
          this.emit(
            input,
            'plan-review.review.contradiction.escalated',
            'warn',
            `escalating review/fix contradiction to arbiter at iteration ${iterationIndex}`,
            { reason: 'contradiction', iterationIndex },
          );
          const guardedArbiter = await this.runGuardedArbiter(input, ctx, () =>
            deps.runArbiter!(ctx, {
              ...fix,
              metadata: {
                iteration: iterationIndex,
                invocation_type: 'initial',
              },
            }),
          );
          if (!guardedArbiter.ok) {
            loop = completeIteration(loop, { outcome: 'unresolved', now: deps.now() });
            loop = exhaust(loop, deps.now());
            deps.loops.update(loop);
            return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
          }
          const arbiterResult = guardedArbiter.result;
          const grounding = verifyPlanReviewArbiterGrounding(arbiterResult);
          const effectiveArbiterResult =
            grounding.status === 'ungrounded'
              ? {
                  ...arbiterResult,
                  outcome: 'finding_invalid' as const,
                  rationale: `Deterministic grounding rejected finding_valid: ${grounding.reason}.`,
                  evidence: `[Override] Ungrounded finding_valid: ${grounding.reason}. The arbiter's ruling has been overridden to finding_invalid because it did not provide mechanically verified quotes from plan.md or task-manifest.json.`,
                }
              : arbiterResult;
          if (grounding.status === 'ungrounded') {
            this.emit(
              input,
              'plan-review.arbiter.hallucination_detected',
              'warn',
              `overriding ungrounded contradiction arbiter finding at iteration ${iterationIndex}`,
              {
                path: 'contradiction',
                iterationIndex,
                originalRuling: 'finding_valid',
                effectiveRuling: 'finding_invalid',
                reason: grounding.reason,
                quoteCount: grounding.quotes.length,
                unmatchedQuotes: grounding.unmatchedQuotes,
              },
            );
          }
          history.push({
            type: 'arbiter',
            iterationIndex,
            data: {
              reviewType: 'regular',
              outcome: effectiveArbiterResult.outcome,
              evidence: effectiveArbiterResult.evidence,
              rationale: effectiveArbiterResult.rationale,
            },
          });
          if (effectiveArbiterResult.outcome === 'insufficient_evidence' && isGateManufactured) {
            this.emit(
              input,
              'plan-review.review.contradiction.resolved',
              'info',
              `arbiter returned insufficient_evidence on gate-manufactured P1 at iteration ${iterationIndex}; resolving as pass`,
              {
                ruling: 'finding_invalid',
                resolvedBy: 'gate-manufactured-recovery',
                iterationIndex,
              },
            );
            loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
            deps.loops.update(loop);
            return { outcome: 'success', loop, proceedWithConcerns: false };
          }
          if (
            !effectiveArbiterResult.evidence ||
            effectiveArbiterResult.evidence.trim().length === 0
          ) {
            this.emit(
              input,
              'plan-review.needs_human_review',
              'warn',
              `arbiter returned empty evidence at iteration ${iterationIndex} — escalating to human`,
              { iterationIndex, outcome: effectiveArbiterResult.outcome },
            );
            loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
            deps.loops.update(loop);
            return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
          }
          if (effectiveArbiterResult.outcome === 'finding_invalid') {
            this.emit(
              input,
              'plan-review.review.contradiction.resolved',
              'info',
              `arbiter resolved contradiction at iteration ${iterationIndex}: ${effectiveArbiterResult.outcome}`,
              {
                ruling: effectiveArbiterResult.outcome,
                resolvedBy: 'contradiction-arbiter',
                evidence: effectiveArbiterResult.evidence,
                iterationIndex,
              },
            );
            loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
            deps.loops.update(loop);
            return { outcome: 'success', loop, proceedWithConcerns: false };
          }
          if (effectiveArbiterResult.outcome === 'finding_valid') {
            this.emit(
              input,
              'plan-review.review.contradiction.resolved',
              'info',
              `arbiter resolved contradiction at iteration ${iterationIndex}: ${effectiveArbiterResult.outcome}`,
              {
                ruling: effectiveArbiterResult.outcome,
                evidence: effectiveArbiterResult.evidence,
                iterationIndex,
              },
            );
            pendingReconciliationContext = effectiveArbiterResult.rationale;
            arbiterAlreadyRuledValid = true;
            loop = completeIteration(loop, {
              outcome: 'unresolved',
              fixInvocationId: fix.invocationId,
              now: deps.now(),
            });
            deps.loops.update(loop);
            continue;
          }
          if (
            (effectiveArbiterResult.outcome === 'ambiguous' ||
              effectiveArbiterResult.outcome === 'insufficient_evidence') &&
            effectiveArbiterResult.evidence &&
            effectiveArbiterResult.evidence.trim().length > 0
          ) {
            this.emit(
              input,
              'plan-review.needs_human_review',
              'warn',
              `arbiter could not resolve contradiction at iteration ${iterationIndex}: ${effectiveArbiterResult.outcome}`,
              {
                ruling: effectiveArbiterResult.outcome,
                evidence: effectiveArbiterResult.evidence,
                iterationIndex,
              },
            );
            loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
            deps.loops.update(loop);
            return this.escalateToTerminalFix(
              input,
              loop,
              'arbiter_' + effectiveArbiterResult.outcome,
              history,
              lastDeterministicDiagnostic,
            );
          }
          this.emit(
            input,
            'plan-review.needs_human_review',
            'warn',
            `arbiter could not resolve contradiction at iteration ${iterationIndex}: ${effectiveArbiterResult.outcome}`,
            {
              ruling: effectiveArbiterResult.outcome,
              evidence: effectiveArbiterResult.evidence,
              iterationIndex,
            },
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

      const shouldVerifyPostReopen =
        pendingPostReopenVerification &&
        finalFullGrantUsed &&
        !postReopenVerificationUsed &&
        iterationIndex === loop.maxIterations;

      if (shouldVerifyPostReopen) {
        pendingPostReopenVerification = false;
        postReopenVerificationUsed = true;

        const verificationIteration = loop.iterations.length + 1;
        this.emit(
          input,
          'plan-review.loop.post_reopen_verification.started',
          'info',
          `post-reopen verification started`,
          {
            fixedIteration: iterationIndex,
            verificationIteration,
            reason: 'reopened_final_full_fix_at_boundary',
          },
        );

        const verificationCtx = { ...baseCtx, iterationIndex: verificationIteration };
        const deterministicResult = await deps.checkDeterministicPlan(verificationCtx);

        let outcome: 'resolved' | 'unresolved' | 'failed' = 'failed';
        let reviewResult: PlanReviewResult | undefined;
        let proceedWithConcernsFromVerdict = false;
        let skipTerminalFix = false;
        if (deterministicResult.diagnostic) {
          this.emit(
            input,
            'plan-review.loop.post_reopen_verification.deterministic_failed',
            'warn',
            `post-reopen verification failed deterministic check: ${deterministicResult.diagnostic}`,
            { diagnostic: deterministicResult.diagnostic },
          );
          outcome = 'unresolved';
          history.push({
            type: 'deterministic_check',
            iterationIndex: verificationIteration,
            data: { diagnostic: deterministicResult.diagnostic },
          });
        } else {
          const snapshot = await deps.captureSnapshot(verificationCtx);

          let reviewAttempts = 0;
          while (reviewAttempts <= reviewerMaxRetries) {
            reviewAttempts += 1;
            const guardedResult = await this.runGuardedReview(
              input,
              {
                ...verificationCtx,
                metadata: {
                  iteration: verificationIteration,
                  invocation_type: reviewAttempts === 1 ? 'initial' : 'retry',
                  reviewMode: 'final_full',
                },
              },
              {
                mode: 'final_full',
                ...(snapshot ? { snapshot } : {}),
              },
            );
            if (!guardedResult.ok) {
              const verificationIterationObj: import('@ai-sdlc/domain').LoopIteration = {
                index: verificationIteration,
                reviewInvocationId: '',
                startedAt: deps.now(),
                completedAt: deps.now(),
                outcome: 'unresolved',
              };
              loop = {
                ...loop,
                iterations: [...loop.iterations, verificationIterationObj],
              };
              loop = exhaust(loop, deps.now());
              deps.loops.update(loop);
              return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
            }
            reviewResult = guardedResult.review;
            if (reviewResult.agentOutcome === 'success' && reviewResult.verdict !== undefined)
              break;
            if (reviewAttempts <= reviewerMaxRetries) {
              this.emit(
                input,
                'plan-review.reviewer.retry',
                'warn',
                `plan-review reviewer attempt ${reviewAttempts} failed (invocation ${reviewResult.invocationId}), retrying...`,
                {
                  attempt: reviewAttempts,
                  maxAttempts: reviewerMaxRetries + 1,
                  agentOutcome: reviewResult.agentOutcome,
                  hasVerdict: reviewResult.verdict !== undefined,
                  invocationId: reviewResult.invocationId,
                },
              );
            }
          }

          proceedWithConcernsFromVerdict = false;
          if (
            reviewResult &&
            reviewResult.agentOutcome === 'success' &&
            reviewResult.verdict !== undefined
          ) {
            const verbatimVerdict = reviewResult.verdict;
            const eligibleFindings = (reviewResult.findings ?? []).filter(
              (f) => f.evidence === 'grounded',
            );
            const adjustedVerdict = this.computeVerdict(reviewResult.verdict, eligibleFindings);
            reviewResult = { ...reviewResult, verdict: adjustedVerdict };

            deps.reviewStateRepository?.appendAttempt(
              buildPlanReviewAttempt({
                attemptId: reviewResult.invocationId,
                runId: input.runId as string,
                phaseId: input.phaseId as string,
                reviewMode: 'final_full',
                ...(reviewResult.snapshot ? { snapshot: reviewResult.snapshot } : {}),
                ...(reviewResult.verdict ? { verdict: reviewResult.verdict } : {}),
                now: deps.now,
              }),
            );

            const artifactDrifted =
              snapshot !== undefined &&
              reviewResult.snapshot !== undefined &&
              (snapshot.planMdDigest !== reviewResult.snapshot.planMdDigest ||
                snapshot.manifestDigest !== reviewResult.snapshot.manifestDigest);

            if (artifactDrifted) {
              this.emit(
                input,
                'plan-review.loop.post_reopen_verification.artifact_drift_detected',
                'error',
                `artifact drift detected in post-reopen verification; escalating to human`,
                {
                  iteration: verificationIteration,
                  baselineDigest: snapshot.planMdDigest,
                  verificationDigest: reviewResult.snapshot?.planMdDigest,
                },
              );
              outcome = 'unresolved';
              skipTerminalFix = true;
            } else if (
              reviewResult.verdict === 'pass' ||
              reviewResult.verdict === 'p2_only' ||
              reviewResult.verdict === 'proceed_with_concerns'
            ) {
              outcome = 'resolved';
              proceedWithConcernsFromVerdict = verbatimVerdict === 'proceed_with_concerns';
            } else {
              outcome = 'unresolved';
            }
            history.push({
              type: 'review',
              iterationIndex: verificationIteration,
              data: {
                mode: 'final_full' as const,
                findings: (reviewResult.findings ?? []).map((f) => ({
                  severity: f.severity,
                  citation: f.citation,
                  failureScenario: f.failureScenario,
                  evidence: f.evidence,
                  disposition: 'still_open' as const,
                })),
              },
            });
          } else {
            this.emit(
              input,
              'plan-review.reviewer.failed',
              'error',
              `reviewer exhausted retry budget at verification iteration ${verificationIteration}`,
              { iterationIndex: verificationIteration, attempts: reviewAttempts },
            );
            const verificationIterationObj: import('@ai-sdlc/domain').LoopIteration = {
              index: verificationIteration,
              reviewInvocationId: reviewResult?.invocationId ?? '',
              startedAt: deps.now(),
              completedAt: deps.now(),
              outcome: 'failed' as const,
            };
            loop = {
              ...loop,
              iterations: [...loop.iterations, verificationIterationObj],
            };
            loop = exhaust(loop, deps.now());
            deps.loops.update(loop);
            this.emit(
              input,
              'plan-review.loop.iteration.completed',
              'info',
              `iteration ${verificationIteration} completed: failed`,
              {
                index: verificationIteration,
                outcome: 'failed',
                verification: 'post_reopen_final_full',
              },
            );
            return { outcome: 'failed', loop, proceedWithConcerns: false };
          }
        }

        const verificationIterationObj: import('@ai-sdlc/domain').LoopIteration = {
          index: verificationIteration,
          reviewInvocationId: reviewResult?.invocationId ?? '',
          startedAt: deps.now(),
          completedAt: deps.now(),
          outcome,
        };

        loop = {
          ...loop,
          iterations: [...loop.iterations, verificationIterationObj],
        };

        this.emit(
          input,
          'plan-review.loop.iteration.completed',
          'info',
          `iteration ${verificationIteration} completed: ${outcome}`,
          {
            index: verificationIteration,
            outcome,
            verification: 'post_reopen_final_full',
          },
        );

        if (outcome === 'resolved') {
          loop = {
            ...loop,
            status: 'converged',
            completedAt: deps.now(),
          };
          deps.loops.update(loop);
          return {
            outcome: 'success',
            loop,
            proceedWithConcerns: proceedWithConcernsFromVerdict,
            ...(reviewResult?.knownLimitations
              ? { knownLimitations: reviewResult.knownLimitations }
              : {}),
          };
        } else {
          loop = exhaust(loop, deps.now());
          deps.loops.update(loop);
          this.emit(
            input,
            'plan-review.loop.exhausted',
            'error',
            `plan-review loop exhausted after ${loop.iterations.length} iterations`,
            { iterations: loop.iterations.length, maxIterations: loop.maxIterations },
          );
          if (skipTerminalFix) {
            return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
          }
          return this.escalateToTerminalFix(
            input,
            loop,
            'loop_exhausted',
            history,
            lastDeterministicDiagnostic,
          );
        }
      }

      if (iterationIndex === loop.maxIterations && !finalFullGrantUsed) {
        const syncResult = await checkAndFixDeterministic({
          ...baseCtx,
          iterationIndex: loop.iterations.length + 1,
        });
        loop = syncResult.loop;
        if (!syncResult.success) {
          loop = exhaust(loop, deps.now());
          deps.loops.update(loop);
          return this.escalateToTerminalFix(
            input,
            loop,
            'loop_exhausted',
            history,
            lastDeterministicDiagnostic,
          );
        }
        const finalIterationIndex = loop.iterations.length + 1;
        const finalCtx: PlanReviewContext = { ...baseCtx, iterationIndex: finalIterationIndex };
        finalFullPhase = true;
        preFinalFullSnapshot = await deps.captureSnapshot(finalCtx);

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
          const guardedResult = await this.runGuardedReview(
            input,
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
          if (!guardedResult.ok) {
            loop = {
              ...loop,
              iterations: [
                ...loop.iterations,
                {
                  index: finalIterationIndex,
                  reviewInvocationId: '',
                  startedAt: deps.now(),
                  completedAt: deps.now(),
                  outcome: 'unresolved',
                },
              ],
            };
            loop = exhaust(loop, deps.now());
            deps.loops.update(loop);
            return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
          }
          finalReview = guardedResult.review;
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

        history.push({
          type: 'review',
          iterationIndex: finalIterationIndex,
          data: {
            mode: 'final_full',
            findings: (finalReview.findings ?? []).map((f) => ({
              severity: f.severity,
              citation: f.citation,
              failureScenario: f.failureScenario,
              evidence: f.evidence,
              disposition: frozenDispositions.get(f.citation) ?? 'still_open',
            })),
          },
        });

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

        let eligibleFinalFindings: ReadonlyArray<PlanReviewFinding> = [];
        let finalIsGateManufactured = false;
        if (deltaScopedReReview) {
          eligibleFinalFindings = (finalReview.findings ?? []).filter(
            (f) => f.evidence === 'grounded',
          );
          const adjustedFinalVerdict = this.computeVerdict(
            finalReview.verdict!,
            eligibleFinalFindings,
          );
          if (adjustedFinalVerdict !== finalReview.verdict) {
            this.emit(
              input,
              'plan-review.review.evidence.gate_applied',
              'info',
              `evidence-bound gate adjusted final verdict from ${finalReview.verdict} to ${adjustedFinalVerdict} at iteration ${finalIterationIndex}`,
              {
                iterationIndex: finalIterationIndex,
                originalVerdict: finalReview.verdict,
                adjustedVerdict: adjustedFinalVerdict,
              },
            );
          }
          finalIsGateManufactured =
            finalReview.verdict === 'pass' && adjustedFinalVerdict === 'p1_found';
          finalReview = { ...finalReview, verdict: adjustedFinalVerdict };
        }

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
          const guardedArbiter = await this.runGuardedArbiter(input, finalCtx, () =>
            deps.runFinalReviewArbiter!(finalCtx, {
              ...finalReview,
              metadata: {
                iteration: finalIterationIndex,
                invocation_type: 'initial',
              },
            }),
          );
          if (!guardedArbiter.ok) {
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
          const arbiterResult = guardedArbiter.result;
          const grounding = verifyPlanReviewArbiterGrounding(arbiterResult);
          const effectiveArbiterResult =
            grounding.status === 'ungrounded'
              ? {
                  ...arbiterResult,
                  outcome: 'finding_invalid' as const,
                  rationale: `Deterministic grounding rejected finding_valid: ${grounding.reason}.`,
                  evidence: `[Override] Ungrounded finding_valid: ${grounding.reason}. The arbiter's ruling has been overridden to finding_invalid because it did not provide mechanically verified quotes from plan.md or task-manifest.json.`,
                }
              : arbiterResult;
          if (grounding.status === 'ungrounded') {
            this.emit(
              input,
              'plan-review.arbiter.hallucination_detected',
              'warn',
              `overriding ungrounded final review arbiter finding at iteration ${finalIterationIndex}`,
              {
                path: 'final_review',
                iterationIndex: finalIterationIndex,
                originalRuling: 'finding_valid',
                effectiveRuling: 'finding_invalid',
                reason: grounding.reason,
                quoteCount: grounding.quotes.length,
                unmatchedQuotes: grounding.unmatchedQuotes,
              },
            );
          }
          history.push({
            type: 'arbiter',
            iterationIndex: finalIterationIndex,
            data: {
              reviewType: 'final',
              outcome: effectiveArbiterResult.outcome,
              evidence: effectiveArbiterResult.evidence,
              rationale: effectiveArbiterResult.rationale,
            },
          });
          if (
            effectiveArbiterResult.outcome === 'insufficient_evidence' &&
            finalIsGateManufactured
          ) {
            this.emit(
              input,
              'plan-review.final_review.arbiter.resolved',
              'info',
              `arbiter returned insufficient_evidence on gate-manufactured P1 (final review) at iteration ${finalIterationIndex}; resolving as pass`,
              {
                ruling: 'finding_invalid',
                resolvedBy: 'gate-manufactured-recovery',
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
            return {
              outcome: 'success',
              loop,
              proceedWithConcerns: false,
              ...(finalReview.knownLimitations
                ? { knownLimitations: finalReview.knownLimitations }
                : {}),
            };
          }
          if (
            !effectiveArbiterResult.evidence ||
            effectiveArbiterResult.evidence.trim().length === 0
          ) {
            this.emit(
              input,
              'plan-review.needs_human_review',
              'warn',
              `final review arbiter returned empty evidence at iteration ${finalIterationIndex} — escalating to human`,
              { iterationIndex: finalIterationIndex, outcome: effectiveArbiterResult.outcome },
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
          if (effectiveArbiterResult.outcome === 'finding_invalid') {
            this.emit(
              input,
              'plan-review.final_review.arbiter.resolved',
              'info',
              `arbiter resolved final review fail at iteration ${finalIterationIndex}: ${effectiveArbiterResult.outcome}`,
              {
                ruling: effectiveArbiterResult.outcome,
                resolvedBy: 'final-review-arbiter',
                evidence: effectiveArbiterResult.evidence,
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
            effectiveArbiterResult.outcome === 'finding_valid' &&
            !bonusIterationUsed &&
            options.bonusIteration !== false
          ) {
            this.emit(
              input,
              'plan-review.loop.trailing_review.bonus_fix_iteration',
              'info',
              `granting one-time bonus fix iteration for valid trailing finding at iteration ${finalIterationIndex}`,
              { iterationIndex: finalIterationIndex, rationale: effectiveArbiterResult.rationale },
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
              reconciliationContext: effectiveArbiterResult.rationale,
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
              const syncResult = await checkAndFixDeterministic({
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
                const guardedResult = await this.runGuardedReview(
                  input,
                  {
                    ...confirmCtx,
                    metadata: {
                      iteration: confirmIterationIndex,
                      invocation_type: confirmAttempts === 1 ? 'initial' : 'retry',
                    },
                  },
                  buildReviewStepOptions(confirmIterationIndex, 'final_full', true),
                );
                if (!guardedResult.ok) {
                  const confirmIteration: import('@ai-sdlc/domain').LoopIteration = {
                    index: confirmIterationIndex,
                    reviewInvocationId: '',
                    startedAt: deps.now(),
                    completedAt: deps.now(),
                    outcome: 'unresolved',
                  };
                  loop = {
                    ...loop,
                    iterations: [...loop.iterations, confirmIteration],
                  };
                  loop = exhaust(loop, deps.now());
                  deps.loops.update(loop);
                  return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
                }
                confirmReview = guardedResult.review;
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
              `arbiter could not resolve final review fail at iteration ${finalIterationIndex}: ${effectiveArbiterResult.outcome}`,
              {
                ruling: effectiveArbiterResult.outcome,
                evidence: effectiveArbiterResult.evidence,
                iterationIndex: finalIterationIndex,
              },
            );
            if (
              (effectiveArbiterResult.outcome === 'ambiguous' ||
                effectiveArbiterResult.outcome === 'insufficient_evidence') &&
              effectiveArbiterResult.evidence &&
              effectiveArbiterResult.evidence.trim().length > 0
            ) {
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
              return this.escalateToTerminalFix(
                input,
                loop,
                'arbiter_' + effectiveArbiterResult.outcome,
                history,
                lastDeterministicDiagnostic,
              );
            }
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
    return this.escalateToTerminalFix(
      input,
      loop,
      'loop_exhausted',
      history,
      lastDeterministicDiagnostic,
    );
  }

  private async escalateToTerminalFix(
    input: PlanReviewLoopInput,
    loop: Loop,
    triggerReason: string,
    history: HistoryItem[],
    lastDeterministicDiagnostic: string | null,
  ): Promise<PlanReviewLoopResult> {
    const { deps } = this;
    if (!deps.terminalFixProfile) {
      return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
    }

    const priorIterations = loop.iterations.length;
    this.emit(
      input,
      'plan-review.terminal_fix.started',
      'info',
      `Terminal fix started using profile: ${deps.terminalFixProfile}`,
      {
        profile: deps.terminalFixProfile,
        priorIterations,
        triggerReason,
      },
    );

    const formattedHistory = formatHistory(history);

    const fixCtx: PlanReviewContext = {
      loopId: loop.id,
      runId: input.runId,
      phaseId: input.phaseId,
      repoId: input.repoId,
      cwd: input.cwd,
      iterationIndex: priorIterations + 1,
    };

    const fixResult = await deps.runFix(fixCtx, {
      isTerminalFix: true,
      triggerReason,
      historyContext: formattedHistory,
      ...(lastDeterministicDiagnostic
        ? { deterministicDiagnostic: lastDeterministicDiagnostic }
        : {}),
      metadata: {
        invocation_type: 'terminal_fix',
      },
    });

    if (fixResult.agentOutcome === 'failed') {
      return { outcome: 'failed', loop, proceedWithConcerns: false };
    }

    if (fixResult.verdict === 'done_no_fixes_needed' && lastDeterministicDiagnostic !== null) {
      const checkResult = await deps.checkDeterministicPlan(fixCtx);
      if (checkResult.diagnostic === lastDeterministicDiagnostic) {
        this.emit(
          input,
          'plan-review.terminal_fix.rejected',
          'warn',
          `Terminal fix rejected: fixer declared done_no_fixes_needed but the deterministic check still fails identically (${checkResult.diagnostic})`,
          {
            diagnostics: [checkResult.diagnostic],
            changedArtifacts: {},
            summary: `Terminal fix rejected: fixer declared done_no_fixes_needed but the deterministic check still fails identically`,
          },
        );
        return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
      }
    }

    if (deps.validateTerminalFix) {
      const valResult = await deps.validateTerminalFix(fixCtx);
      if (valResult.passed) {
        this.emit(
          input,
          'plan-review.terminal_fix.accepted',
          'info',
          `Terminal fix accepted: ${valResult.summary}`,
          {
            diagnostics: valResult.diagnostics,
            changedArtifacts: valResult.changedArtifacts,
            summary: valResult.summary,
          },
        );
        return { outcome: 'success', loop, proceedWithConcerns: false };
      } else {
        this.emit(
          input,
          'plan-review.terminal_fix.rejected',
          'warn',
          `Terminal fix rejected: ${valResult.summary}`,
          {
            diagnostics: valResult.diagnostics,
            changedArtifacts: valResult.changedArtifacts,
            summary: valResult.summary,
          },
        );
        return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
      }
    }

    return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
  }

  private async runGuardedInvocation<T>(params: {
    input: PlanReviewLoopInput;
    ctx: PlanReviewContext;
    agentRole: 'reviewer' | 'arbiter';
    permittedStatusPaths: ReadonlyArray<string>;
    reviewMode?: ReviewMode;
    invoke: () => Promise<T>;
    extractInvocationId?: (res: T) => string | undefined;
  }): Promise<{ ok: true; result: T } | { ok: false }> {
    const { input, ctx, agentRole, permittedStatusPaths, reviewMode, invoke, extractInvocationId } =
      params;
    let baselineSha: string | undefined;
    let baselineSnapshot: PlanReviewSnapshot | undefined;
    let baselineError: string | undefined;

    // 1. Capture baseline HEAD and the protected snapshot immediately before the Agent Invocation.
    try {
      baselineSha = await this.deps.git.headCommitSha(ctx.cwd);
    } catch (err) {
      baselineError = err instanceof Error ? err.message : String(err);
    }
    try {
      baselineSnapshot = await this.deps.captureSnapshot(ctx);
    } catch {
      baselineSnapshot = undefined;
    }

    if (baselineError !== undefined) {
      // Baseline capture failed: do not invoke agent, attempt safe cleanup without inventing a SHA.
      const cleanAttempted = true;
      let cleanSuccess = false;
      let cleanError: string | undefined;
      try {
        await this.deps.git.cleanUntracked(ctx.cwd);
        cleanSuccess = true;
      } catch (err) {
        cleanSuccess = false;
        cleanError = err instanceof Error ? err.message : String(err);
      }

      this.emit(
        input,
        'plan-review.read_only_violation',
        'error',
        `read-only ${agentRole} guard baseline capture failed: ${baselineError}`,
        {
          phase: 'plan-review',
          iteration: ctx.iterationIndex,
          ...(reviewMode ? { reviewMode } : {}),
          files: [],
          detectionError: baselineError,
          resetAttempted: false,
          resetSuccess: false,
          cleanAttempted,
          cleanSuccess,
          ...(cleanError ? { cleanError } : {}),
        },
      );
      return { ok: false };
    }

    // 2. Invoke the agent exactly once.
    let result: T;
    try {
      result = await invoke();
    } catch (err) {
      const invokeError = err instanceof Error ? err.message : String(err);
      let resetAttempted = false;
      let resetSuccess = false;
      let resetError: string | undefined;
      const cleanAttempted = true;
      let cleanSuccess = false;
      let cleanError: string | undefined;

      if (baselineSha !== undefined) {
        resetAttempted = true;
        try {
          await this.deps.git.resetHard(ctx.cwd, baselineSha);
          resetSuccess = true;
        } catch (rErr) {
          resetSuccess = false;
          resetError = rErr instanceof Error ? rErr.message : String(rErr);
        }
      }

      try {
        await this.deps.git.cleanUntracked(ctx.cwd);
        cleanSuccess = true;
      } catch (cErr) {
        cleanSuccess = false;
        cleanError = cErr instanceof Error ? cErr.message : String(cErr);
      }

      this.emit(
        input,
        'plan-review.read_only_violation',
        'error',
        `read-only ${agentRole} invocation failed: ${invokeError}`,
        {
          phase: 'plan-review',
          iteration: ctx.iterationIndex,
          ...(reviewMode ? { reviewMode } : {}),
          ...(baselineSha !== undefined ? { baselineSha } : {}),
          files: [],
          detectionError: invokeError,
          resetAttempted,
          resetSuccess,
          ...(resetError ? { resetError } : {}),
          cleanAttempted,
          cleanSuccess,
          ...(cleanError ? { cleanError } : {}),
        },
      );
      return { ok: false };
    }

    // 3. Before inspecting agent outcome or verdict,
    // capture end HEAD, raw status paths through parseGitStatusPaths,
    // committed paths through changedFiles(cwd, baselineSha, endSha) when HEAD changed,
    // and a post-invocation protected snapshot.
    let endSha: string | undefined;
    let statusPaths: string[] = [];
    let committedPaths: string[] = [];
    let postSnapshot: PlanReviewSnapshot | undefined;
    let inspectionError: string | undefined;

    try {
      endSha = await this.deps.git.headCommitSha(ctx.cwd);
      const statusOutput = await this.deps.git.status(ctx.cwd);
      statusPaths = parseGitStatusPaths(statusOutput);

      if (baselineSha !== undefined && endSha !== baselineSha) {
        committedPaths = await this.deps.git.changedFiles(ctx.cwd, baselineSha, endSha);
      }
    } catch (err) {
      inspectionError = err instanceof Error ? err.message : String(err);
    }

    try {
      postSnapshot = await this.deps.captureSnapshot(ctx);
    } catch (err) {
      postSnapshot = undefined;
      if (baselineSnapshot !== undefined) {
        inspectionError = inspectionError ?? (err instanceof Error ? err.message : String(err));
      }
    }

    // 4. Mark any HEAD transition as a violation even if changedFiles is empty.
    // Combine all committed paths; all Git-visible paths except permitted paths;
    // and plan.md, task-manifest.json, or design.md for changed available digests.
    // Normalize, deduplicate, and sort the diagnostic list.
    const violatingFilesSet = new Set<string>();

    for (const p of committedPaths) {
      violatingFilesSet.add(normalizeWorktreePath(p));
    }

    for (const rawPath of statusPaths) {
      if (!isPermittedStatusPath(rawPath, permittedStatusPaths)) {
        violatingFilesSet.add(normalizeWorktreePath(rawPath));
      }
    }

    if (baselineSnapshot && postSnapshot) {
      if (
        baselineSnapshot.planMdDigest &&
        postSnapshot.planMdDigest &&
        baselineSnapshot.planMdDigest !== postSnapshot.planMdDigest
      ) {
        violatingFilesSet.add('plan.md');
      }
      if (
        baselineSnapshot.manifestDigest &&
        postSnapshot.manifestDigest &&
        baselineSnapshot.manifestDigest !== postSnapshot.manifestDigest
      ) {
        violatingFilesSet.add('task-manifest.json');
      }
      if (
        baselineSnapshot.designDigest &&
        postSnapshot.designDigest &&
        baselineSnapshot.designDigest !== postSnapshot.designDigest
      ) {
        violatingFilesSet.add('design.md');
      }
    }

    const headTransition =
      baselineSha !== undefined && endSha !== undefined && endSha !== baselineSha;
    const isViolation =
      inspectionError !== undefined || headTransition || violatingFilesSet.size > 0;

    // 5. If state is clean, return the untouched result.
    if (!isViolation) {
      return { ok: true, result };
    }

    // 6. On a detected violation or post-invocation inspection failure, attempt
    // resetHard(cwd, baselineSha) and then cleanUntracked(cwd) in independent try blocks.
    let resetAttempted = false;
    let resetSuccess = false;
    let resetError: string | undefined;

    if (baselineSha !== undefined) {
      resetAttempted = true;
      try {
        await this.deps.git.resetHard(ctx.cwd, baselineSha);
        resetSuccess = true;
      } catch (err) {
        resetSuccess = false;
        resetError = err instanceof Error ? err.message : String(err);
      }
    }

    const cleanAttempted = true;
    let cleanSuccess = false;
    let cleanError: string | undefined;
    try {
      await this.deps.git.cleanUntracked(ctx.cwd);
      cleanSuccess = true;
    } catch (err) {
      cleanSuccess = false;
      cleanError = err instanceof Error ? err.message : String(err);
    }

    // 7. Emit exactly one plan-review.read_only_violation event at error level
    const sortedViolatingFiles = Array.from(violatingFilesSet).sort();
    const invocationId = extractInvocationId ? extractInvocationId(result) : undefined;

    this.emit(
      input,
      'plan-review.read_only_violation',
      'error',
      inspectionError
        ? `read-only ${agentRole} guard failed during inspection: ${inspectionError}`
        : `read-only violation detected during plan-review ${agentRole} invocation: ${sortedViolatingFiles.join(', ')}`,
      {
        phase: 'plan-review',
        ...(invocationId ? { invocationId } : {}),
        ...(reviewMode ? { reviewMode } : {}),
        iteration: ctx.iterationIndex,
        ...(baselineSha !== undefined ? { baselineSha } : {}),
        ...(endSha !== undefined ? { endSha } : {}),
        files: sortedViolatingFiles,
        ...(inspectionError ? { detectionError: inspectionError } : {}),
        resetAttempted,
        resetSuccess,
        ...(resetError ? { resetError } : {}),
        cleanAttempted,
        cleanSuccess,
        ...(cleanError ? { cleanError } : {}),
      },
    );

    // 8. Return { ok: false }
    return { ok: false };
  }

  private async runGuardedReview(
    input: PlanReviewLoopInput,
    ctx: PlanReviewContext,
    opts?: PlanReviewStepOptions,
  ): Promise<GuardedReviewResult> {
    const reviewMode =
      opts?.mode ?? (ctx.metadata?.reviewMode as ReviewMode | undefined) ?? 'initial_full';
    const res = await this.runGuardedInvocation<PlanReviewResult>({
      input,
      ctx,
      agentRole: 'reviewer',
      permittedStatusPaths: ['plan-review-findings.md'],
      reviewMode,
      invoke: () => this.deps.runReview(ctx, opts),
      extractInvocationId: (r) => r.invocationId,
    });
    if (!res.ok) {
      return { ok: false };
    }
    return { ok: true, review: res.result };
  }

  private async runGuardedArbiter(
    input: PlanReviewLoopInput,
    ctx: PlanReviewContext,
    invoke: () => Promise<PlanReviewArbiterResult>,
  ): Promise<GuardedArbiterResult> {
    return this.runGuardedInvocation<PlanReviewArbiterResult>({
      input,
      ctx,
      agentRole: 'arbiter',
      permittedStatusPaths: ['result.json'],
      invoke,
    });
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
    const hasP2 = eligible.some((f) => f.severity === 'P2');
    if (hasP0 || hasP1 || hasP2) return 'p1_found';

    if (
      reviewerVerdict === 'p1_found' ||
      reviewerVerdict === 'p2_only' ||
      reviewerVerdict === 'proceed_with_concerns'
    ) {
      return 'pass';
    }
    return reviewerVerdict;
  }
}

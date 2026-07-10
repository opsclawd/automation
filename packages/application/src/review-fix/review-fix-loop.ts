import {
  createLoop,
  startIteration,
  completeIteration,
  exhaust,
  type AgentProfileName,
  type Loop,
} from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import {
  detectConvergingTrend,
  detectStall,
  detectUnfoundedPingPong,
  fingerprintFindings,
  type FindingHistoryEntry,
} from './detect-stall.js';
import { extractEvidence } from './extract-evidence.js';
import { appendRebuttalToCodeReview } from './append-rebuttal.js';
import { verifyFixCommit } from '../fix-commit-verifier.js';
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
    // Trackers for the optional runaway-protection caps (#667). Kept
    // separate from `consecutiveFixFailures` so we don't entangle
    // fallback-escalation semantics with the new exit conditions.
    let consecutiveFixFailuresForCap = 0;
    let totalFixAttempts = 0;
    let lastFixInvocationId: string | undefined;
    let lastFailingCategory: string | undefined;
    let lastIterationHadFixCommit = false;
    let outstandingFailedRevalidation = false;
    let lastPostFixGateFailed = false;
    let lastOffendingFindings: Array<{ severity: string; summary: string }> = [];
    let lastReviewedCommitSha: string | undefined;
    const findingHistory: Array<Set<string>> = [];
    const unfoundedHistory: FindingHistoryEntry[] = [];

    const opts = { ...(this.deps.options ?? {}), ...(input.options ?? {}) };
    const endOnReview = opts.endOnReview ?? true;
    const originalMax = loop.maxIterations;

    const canStartReviewCycle = (loop: typeof thisLoop): boolean => {
      const reviewsStarted = loop.iterations.length;
      if (reviewsStarted < originalMax) return true;
      // Trailing post-fix re-review: only when the last iteration ended
      // with `fixed` (a fix commit was produced).
      if (!endOnReview) return false;
      if (reviewsStarted > originalMax) return false;
      const last = loop.iterations[loop.iterations.length - 1];
      return last?.outcome === 'fixed';
    };

    let thisLoop: Loop = loop;
    while (canStartReviewCycle(thisLoop)) {
      if (thisLoop.iterations.length === originalMax) {
        thisLoop = { ...thisLoop, maxIterations: thisLoop.iterations.length + 1 };
      }
      loop = thisLoop;
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
        lastPostFixGateFailed = gateResult.outcome === 'fail';
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
        ...(iterationIndex >= 2 && lastReviewedCommitSha && (opts.deltaScopedReReview ?? true)
          ? { prevReviewedCommitSha: lastReviewedCommitSha }
          : {}),
      };
      const review = await deps.runReview(
        ctx,
        Object.keys(reviewOptions).length > 0 ? reviewOptions : undefined,
      );
      if (review.offendingFindings) {
        lastOffendingFindings = review.offendingFindings;
      }

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
      thisLoop = startIteration(thisLoop, {
        reviewInvocationId: review.invocationId,
        now: deps.now(),
      });
      deps.loops.update(thisLoop);

      if (review.agentOutcome !== 'success' || review.verdict === undefined) {
        thisLoop = completeIteration(thisLoop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(thisLoop);
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
            thisLoop = completeIteration(thisLoop, { outcome: 'resolved', now: deps.now() });
            deps.loops.update(thisLoop);
            this.emitIterationCompleted(input, iterationIndex, 'resolved');
            await this.appendHistoryEntry(ctx, review, undefined, reval, 'resolved', input);
            break;
          }
          thisLoop = completeIteration(thisLoop, {
            outcome: 'unresolved',
            revalidationId: reval.validationRunId,
            now: deps.now(),
          });
          deps.loops.update(thisLoop);
          this.emitIterationCompleted(input, iterationIndex, 'unresolved');
          await this.appendHistoryEntry(ctx, review, undefined, reval, 'unresolved', input);
          continue;
        }
        thisLoop = completeIteration(thisLoop, { outcome: 'resolved', now: deps.now() });
        deps.loops.update(thisLoop);
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

      if (iterationIndex > originalMax) {
        thisLoop = completeIteration(thisLoop, { outcome: 'unresolved', now: deps.now() });
        deps.loops.update(thisLoop);
        this.emitIterationCompleted(input, iterationIndex, 'unresolved');
        await this.appendHistoryEntry(ctx, review, undefined, undefined, 'unresolved', input);
        break;
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
        consecutiveFixFailuresForCap += 1;
        lastIterationHadFixCommit = false;

        // --- RUNAWAY-PROTECTION CAP: maxConsecutiveFixFailures (#667) ---
        const consecutiveCap = input.maxConsecutiveFixFailures;
        const capHit =
          consecutiveCap !== undefined &&
          consecutiveCap > 0 &&
          consecutiveFixFailuresForCap >= consecutiveCap;
        const outcome = 'unresolved';

        thisLoop = completeIteration(thisLoop, {
          outcome,
          fixInvocationId: fix.invocationId,
          now: deps.now(),
        });
        deps.loops.update(thisLoop);
        this.emitIterationCompleted(input, iterationIndex, outcome);
        await this.appendHistoryEntry(ctx, review, fix, undefined, outcome, input);
        // Record fixer verdict in unfounded-history even on fix failure so
        // the ping-pong detector can see it.
        unfoundedHistory.push({
          findings: unfoundedFingerprints,
          ...(fix.verdict ? { fixerVerdict: fix.verdict } : {}),
        });
        await this.runCleanArtifacts(ctx);

        if (capHit) {
          this.emit(
            input,
            'loop.exhausted.fix_consecutive_failures',
            'warn',
            `review/fix loop exhausted: ${consecutiveFixFailuresForCap} consecutive fixer failures (cap=${consecutiveCap})`,
            {
              iterationIndex,
              consecutiveFixFailuresForCap,
              cap: consecutiveCap,
            },
          );
          thisLoop = exhaust(thisLoop, this.deps.now());
          this.deps.loops.update(thisLoop);
          return {
            loop: thisLoop,
            phaseOutcome: 'failed',
            loopStatus: 'exhausted',
            needsHumanReview: true,
            residualFindingsCount: lastOffendingFindings.length,
          };
        }
        continue;
      }
      const prevConsecutiveFixFailures = consecutiveFixFailures;
      const prevConsecutiveFixFailuresForCap = consecutiveFixFailuresForCap;
      consecutiveFixFailures = 0;
      if (fix.verdict === 'done_with_fixes') {
        consecutiveFixFailuresForCap = 0;
      } else {
        consecutiveFixFailuresForCap += 1;
      }
      lastIterationHadFixCommit = fix.verdict === 'done_with_fixes';
      if (fix.verdict === 'done_with_fixes') {
        lastPostFixGateFailed = false;
        if (review.reviewedCommitSha) {
          lastReviewedCommitSha = review.reviewedCommitSha;
        }
        totalFixAttempts += 1;

        // --- FIX-COMMIT VERIFICATION (#679) ---
        if (this.deps.git && fix.headBeforeFix) {
          const verification = await verifyFixCommit({
            git: this.deps.git,
            cwd: ctx.cwd,
            expectedHead: fix.headBeforeFix,
          });
          if (verification.kind === 'uncommitted_changes') {
            this.emit(
              input,
              'fix.uncommitted_changes',
              'warn',
              `review/fix iteration ${iterationIndex} claimed done_with_fixes but HEAD did not advance and worktree has ${verification.dirtyFiles.length} dirty file(s)`,
              {
                iterationIndex,
                invocationId: fix.invocationId,
                expectedHead: fix.headBeforeFix,
                actualHead: verification.headAfterFix,
                dirtyFiles: verification.dirtyFiles.slice(0, 200),
                statusOutput: verification.statusOutput.slice(0, 4000),
              },
            );

            // --- AUTO-COMMIT FALLBACK ---
            // If the worktree is dirty but valid (passes revalidation), auto-commit on the
            // agent's behalf so correct work isn't lost to minor git/hook failures.
            const reval = await deps.runRevalidation(ctx);
            let autoCommitted = false;
            if (reval.passed) {
              const firstFinding = review.offendingFindings?.[0]?.summary ?? 'uncommitted changes';
              const message = `fix: ${firstFinding} (auto-committed — agent left changes uncommitted)`;
              let committedSha: string | undefined;

              for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                  committedSha = await this.deps.git!.commit(ctx.cwd, message);
                  break;
                } catch (err: unknown) {
                  const msg = err instanceof Error ? err.message : String(err);
                  const isLockError =
                    msg.toLowerCase().includes('index.lock') ||
                    msg.toLowerCase().includes('unable to create');
                  if (attempt === 1 && isLockError) {
                    this.emit(
                      input,
                      'fix.auto_commit.retry',
                      'warn',
                      `auto-commit failed with lock error; retrying once...`,
                      { iterationIndex, error: msg },
                    );
                    continue;
                  }
                  this.emit(
                    input,
                    'fix.auto_commit.failed',
                    'error',
                    `auto-commit fallback failed: ${msg}`,
                    { iterationIndex, error: msg },
                  );
                  break;
                }
              }

              if (committedSha) {
                this.emit(
                  input,
                  'fix.auto_commit.succeeded',
                  'info',
                  `auto-committed ${verification.dirtyFiles.length} dirty file(s) after passing revalidation`,
                  { sha: committedSha, iterationIndex },
                );
                autoCommitted = true;
                // Success: treat this as a productive fix that advanced HEAD.
                lastIterationHadFixCommit = true;
                consecutiveFixFailures = 0;
                consecutiveFixFailuresForCap = 0;
                totalFixAttempts += 1;
                if (review.reviewedCommitSha) {
                  lastReviewedCommitSha = review.reviewedCommitSha;
                }

                thisLoop = completeIteration(thisLoop, {
                  outcome: 'fixed',
                  fixInvocationId: fix.invocationId,
                  revalidationId: reval.validationRunId,
                  now: deps.now(),
                });
                deps.loops.update(thisLoop);
                this.emitIterationCompleted(input, iterationIndex, 'fixed');
                await this.appendHistoryEntry(ctx, review, fix, reval, 'fixed', input);
                // Fall through to the next iteration (re-review) rather than continuing the loop here.
                // We must bypass the redundant revalidation and cap checks below.
              }
            }

            if (!autoCommitted) {
              consecutiveFixFailures = prevConsecutiveFixFailures + 1;
              consecutiveFixFailuresForCap = prevConsecutiveFixFailuresForCap + 1;
              lastIterationHadFixCommit = false;
              thisLoop = completeIteration(thisLoop, {
                outcome: 'unresolved',
                fixInvocationId: fix.invocationId,
                now: this.deps.now(),
              });
              this.deps.loops.update(thisLoop);
              this.emitIterationCompleted(input, iterationIndex, 'unresolved');
              await this.appendHistoryEntry(ctx, review, fix, reval, 'unresolved', input, {
                kind: 'uncommitted_changes',
                dirtyFiles: verification.dirtyFiles,
                statusOutput: verification.statusOutput,
              });
              unfoundedHistory.push({
                findings: unfoundedFingerprints,
                ...(fix.verdict ? { fixerVerdict: fix.verdict } : {}),
              });
              // Do NOT call this.deps.rollbackFix here (plan-review P0, #679):
              // this branch means the fixer left uncommitted changes in the
              // tree (e.g. a pre-commit hook rejected the commit). That dirty
              // state is exactly what the NEXT fixer iteration needs to see in
              // order to finish committing or fixing it — rolling back here
              // would destroy the evidence #679 exists to preserve. Rollback
              // is only correct for the separate build-breaking-fix case
              // (#671), which has its own dedicated branch elsewhere in this
              // loop.
              await this.runCleanArtifacts(ctx);
              // mirror the cap check from the cannot_fix branch below
              const consecutiveCap = input.maxConsecutiveFixFailures;
              if (
                consecutiveCap !== undefined &&
                consecutiveCap > 0 &&
                consecutiveFixFailuresForCap >= consecutiveCap
              ) {
                this.emit(
                  input,
                  'loop.exhausted.fix_consecutive_failures',
                  'warn',
                  `review/fix loop exhausted: ${consecutiveFixFailuresForCap} consecutive fixer failures (cap=${consecutiveCap})`,
                  { iterationIndex, consecutiveFixFailuresForCap, cap: consecutiveCap },
                );
                thisLoop = exhaust(thisLoop, this.deps.now());
                this.deps.loops.update(thisLoop);
                return {
                  loop: thisLoop,
                  phaseOutcome: 'failed',
                  loopStatus: 'exhausted',
                  needsHumanReview: true,
                  residualFindingsCount: lastOffendingFindings.length,
                };
              }
              continue;
            }
            // If we autoCommitted, we fall out of the `uncommitted_changes` block.
            // Since we already completed the iteration as 'fixed', we MUST continue the loop
            // to avoid running the redundant revalidation below.
            continue;
          }
          if (verification.kind === 'no_commit_claimed') {
            this.emit(
              input,
              'fix.no_commit_claimed',
              'warn',
              `review/fix iteration ${iterationIndex} claimed done_with_fixes but HEAD did not advance and worktree is clean`,
              {
                iterationIndex,
                invocationId: fix.invocationId,
                expectedHead: fix.headBeforeFix,
                actualHead: verification.headAfterFix,
              },
            );
            consecutiveFixFailures = prevConsecutiveFixFailures + 1;
            consecutiveFixFailuresForCap = prevConsecutiveFixFailuresForCap + 1;
            lastIterationHadFixCommit = false;
            thisLoop = completeIteration(thisLoop, {
              outcome: 'unresolved',
              fixInvocationId: fix.invocationId,
              now: this.deps.now(),
            });
            this.deps.loops.update(thisLoop);
            this.emitIterationCompleted(input, iterationIndex, 'unresolved');
            await this.appendHistoryEntry(ctx, review, fix, undefined, 'unresolved', input, {
              kind: 'no_commit_claimed',
              statusOutput: verification.statusOutput,
            });
            unfoundedHistory.push({
              findings: unfoundedFingerprints,
              ...(fix.verdict ? { fixerVerdict: fix.verdict } : {}),
            });
            await this.runCleanArtifacts(ctx);
            const consecutiveCap = input.maxConsecutiveFixFailures;
            if (
              consecutiveCap !== undefined &&
              consecutiveCap > 0 &&
              consecutiveFixFailuresForCap >= consecutiveCap
            ) {
              this.emit(
                input,
                'loop.exhausted.fix_consecutive_failures',
                'warn',
                `review/fix loop exhausted: ${consecutiveFixFailuresForCap} consecutive fixer failures (cap=${consecutiveCap})`,
                { iterationIndex, consecutiveFixFailuresForCap, cap: consecutiveCap },
              );
              thisLoop = exhaust(thisLoop, this.deps.now());
              this.deps.loops.update(thisLoop);
              return {
                loop: thisLoop,
                phaseOutcome: 'failed',
                loopStatus: 'exhausted',
                needsHumanReview: true,
                residualFindingsCount: lastOffendingFindings.length,
              };
            }
            continue;
          }
          if (verification.kind === 'verification_error') {
            this.emit(
              input,
              'fix.verification_error',
              'warn',
              `review/fix iteration ${iterationIndex} could not verify fix commit: ${verification.error}`,
              { iterationIndex, invocationId: fix.invocationId, error: verification.error },
            );
          }
        }
        // --- END OF VERIFICATION ---
      }

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

      // --- REBUTTAL-AWARE CONVERGENCE ---
      // If every finding was unfounded AND the fixer returned
      // `done_no_fixes_needed`, accept the rebuttal and converge.
      const findings = review.offendingFindings ?? [];
      const allUnfounded = unfoundedCount === findings.length && findings.length > 0;
      const isRebutted = allUnfounded && fix.verdict === 'done_no_fixes_needed' && reval.passed;

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
        thisLoop = completeIteration(thisLoop, {
          outcome: 'resolved',
          fixInvocationId: fix.invocationId,
          revalidationId: reval.validationRunId,
          now: this.deps.now(),
        });
        this.deps.loops.update(thisLoop);
        this.emitIterationCompleted(input, iterationIndex, 'resolved');
        await this.appendHistoryEntry(ctx, review, fix, reval, 'resolved', input);
        return {
          loop: thisLoop,
          phaseOutcome: 'passed',
          loopStatus: 'converged',
        };
      }

      // Short-circuit on `unfounded_pingpong`: every recent iteration had
      // unfounded findings AND the fixer rebutted every time. Escalate to
      // `needs_human_review` rather than burning the budget.
      const pingPongLimit = this.deps.unfoundedPingPongLimit ?? 4;
      const isPingPong =
        unfoundedCount > 0 &&
        fix.verdict === 'done_no_fixes_needed' &&
        detectUnfoundedPingPong(unfoundedHistory, pingPongLimit);

      if (isPingPong) {
        thisLoop = completeIteration(thisLoop, {
          outcome: 'failed',
          fixInvocationId: fix.invocationId,
          revalidationId: reval.validationRunId,
          now: this.deps.now(),
        });
        this.deps.loops.update(thisLoop);
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
          loop: thisLoop,
          phaseOutcome: 'failed',
          loopStatus:
            thisLoop.status === 'converged'
              ? 'converged'
              : thisLoop.status === 'failed'
                ? 'failed'
                : 'exhausted',
          needsHumanReview: true,
          residualFindingsCount: lastOffendingFindings.length,
        };
      }

      // Default path: complete the iteration as fixed or unresolved.
      thisLoop = completeIteration(thisLoop, {
        outcome: reval.passed ? 'fixed' : 'unresolved',
        fixInvocationId: fix.invocationId,
        revalidationId: reval.validationRunId,
        now: deps.now(),
      });
      deps.loops.update(thisLoop);
      this.emitIterationCompleted(input, iterationIndex, reval.passed ? 'fixed' : 'unresolved');

      await this.appendHistoryEntry(
        ctx,
        review,
        fix,
        reval,
        reval.passed ? 'fixed' : 'unresolved',
        input,
      );

      // --- RUNAWAY-PROTECTION CAP: maxTotalFixAttempts (#667) ---
      const totalCap = input.maxTotalFixAttempts;
      if (totalCap !== undefined && totalCap > 0 && totalFixAttempts >= totalCap) {
        this.emit(
          input,
          'loop.exhausted.fix_attempt_cap',
          'warn',
          `review/fix loop exhausted: ${totalFixAttempts} productive fix attempts (cap=${totalCap})`,
          {
            iterationIndex,
            totalFixAttempts,
            cap: totalCap,
          },
        );
        thisLoop = exhaust(thisLoop, this.deps.now());
        this.deps.loops.update(thisLoop);
        return {
          loop: thisLoop,
          phaseOutcome: 'failed',
          loopStatus: 'exhausted',
          needsHumanReview: true,
          residualFindingsCount: lastOffendingFindings.length,
        };
      }

      // --- RUNAWAY-PROTECTION CAP: maxConsecutiveFixFailures (#667) ---
      const consecutiveCap = input.maxConsecutiveFixFailures;
      if (
        consecutiveCap !== undefined &&
        consecutiveCap > 0 &&
        consecutiveFixFailuresForCap >= consecutiveCap
      ) {
        this.emit(
          input,
          'loop.exhausted.fix_consecutive_failures',
          'warn',
          `review/fix loop exhausted: ${consecutiveFixFailuresForCap} consecutive fixer failures (cap=${consecutiveCap})`,
          {
            iterationIndex,
            consecutiveFixFailuresForCap,
            cap: consecutiveCap,
          },
        );
        thisLoop = exhaust(thisLoop, this.deps.now());
        this.deps.loops.update(thisLoop);
        return {
          loop: thisLoop,
          phaseOutcome: 'failed',
          loopStatus: 'exhausted',
          needsHumanReview: true,
          residualFindingsCount: lastOffendingFindings.length,
        };
      }
    }

    loop = thisLoop;

    if (loop.status === 'converged') {
      return { loop, phaseOutcome: 'passed', loopStatus: 'converged' };
    }
    if (loop.status === 'failed') {
      return { loop, phaseOutcome: 'failed', loopStatus: 'failed' };
    }
    loop = exhaust(loop, this.deps.now());
    this.deps.loops.update(loop);

    // Trend-aware exit (#627): if the heuristic says findings are
    // converging AND the post-fix-gate passed (strict mode), return as
    // `converged_with_notes` with `needsHumanReview: true`. The handler
    // routes this to the `needs_human_review` terminal status, and the
    // residual findings get appended to `code-review.md` for the
    // post-pr-review stage to adjudicate.
    const trendOpts = opts.trendAwareExit ?? { enabled: true };
    const trendEnabled = trendOpts.enabled ?? true;
    const trendMode = trendOpts.mode ?? 'strict';
    const trendWindow = trendOpts.window ?? 3;

    if (trendEnabled) {
      const history = this.deps.loopHistory
        ? await this.deps.loopHistory.read({
            loopId: loop.id,
            runId: input.runId,
            phaseId: input.phaseId,
            repoId: input.repoId,
            cwd: input.cwd,
            iterationIndex: loop.iterations.length,
          })
        : [];

      const trend = detectConvergingTrend(history, {
        window: trendWindow,
        mode: trendMode,
        ...(trendMode === 'strict'
          ? { lastRevalidationPassed: !outstandingFailedRevalidation && !lastPostFixGateFailed }
          : {}),
      });

      if (trend.converging) {
        const residualFindings =
          history[history.length - 1]?.review !== undefined ? (lastOffendingFindings ?? []) : [];

        // Append residual findings to code-review.md.
        if (this.deps.artifactStore && residualFindings.length > 0) {
          await this.appendResidualFindings(input, residualFindings, trend.severityWeighted);
        }

        loop = { ...loop, status: 'converged_with_notes' };
        this.deps.loops.update(loop);

        this.emit(
          input,
          'loop.exhausted.with_notes',
          'warn',
          `review/fix loop exhausted with converging trend (${residualFindings.length} residual findings)`,
          {
            iterations: loop.iterations.length,
            maxIterations: loop.maxIterations,
            residualCount: residualFindings.length,
            severityWeighted: trend.severityWeighted,
            trendMode,
          },
        );
        return {
          loop,
          phaseOutcome: 'passed',
          loopStatus: 'converged_with_notes',
          needsHumanReview: true,
          residualFindingsCount: residualFindings.length,
        };
      }
    }

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
    return {
      loop,
      phaseOutcome: 'failed',
      loopStatus: 'exhausted',
      residualFindingsCount: lastOffendingFindings.length,
    };
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
    commitVerification?:
      | { kind: 'uncommitted_changes'; dirtyFiles: string[]; statusOutput: string }
      | { kind: 'no_commit_claimed'; statusOutput: string },
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
          ...(review.reviewedCommitSha !== undefined
            ? { reviewedCommitSha: review.reviewedCommitSha }
            : {}),
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
        ...(fix && commitVerification && commitVerification.kind === 'uncommitted_changes'
          ? {
              uncommittedChanges: {
                dirtyFiles: commitVerification.dirtyFiles,
                statusOutput: commitVerification.statusOutput,
              },
            }
          : {}),
        ...(fix && commitVerification && commitVerification.kind === 'no_commit_claimed'
          ? { noCommit: { statusOutput: commitVerification.statusOutput } }
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
        if (!e.path) return false;
        const basename = e.path.split('/').pop()?.toLowerCase();
        return basename !== undefined && summaryLc.includes(basename);
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

  private async appendResidualFindings(
    input: ReviewFixLoopInput,
    findings: ReadonlyArray<{ severity: string; summary: string }>,
    severityWeighted: number[],
  ): Promise<void> {
    if (!this.deps.artifactStore) return;
    const heading = `## Residual findings (review-fix loop exhausted with converging trend)\n\nThe review-fix loop exhausted its budget but the severity-weighted finding count was trending down across the last iterations. These findings are appended for the post-pr-review stage to adjudicate.\n\n`;
    const list = findings.map((f) => `- [${f.severity}] ${f.summary}`).join('\n');
    const footer = `\n\n_Severity-weighted counts at exhaustion: [${severityWeighted.join(', ')}]_\n`;
    try {
      const existing = await this.deps.artifactStore
        .read(String(input.runId), 'code-review.md')
        .catch(() => '');
      const separator = existing ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
      await this.deps.artifactStore.write({
        runId: String(input.runId),
        phaseId: String(input.phaseId),
        relativePath: 'code-review.md',
        contents: existing + separator + heading + list + footer,
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.emit(input, 'review_loop.append_residual_findings_failed', 'warn', errorMsg, {
        reason: 'append_residual_findings',
        error: errorMsg,
      });
    }
  }
}

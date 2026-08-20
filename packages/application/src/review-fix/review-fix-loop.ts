import { classifyPostFixGateFailure } from './post-fix-gate-classification.js';
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
  fingerprintSingleFinding,
  type FindingHistoryEntry,
} from './detect-stall.js';
import { extractEvidence } from './extract-evidence.js';
import { appendRebuttalToCodeReview } from './append-rebuttal.js';
import { verifyFixCommit } from '../fix-commit-verifier.js';
import {
  checkTaskBoundaries,
  loadManifest,
  type ManifestLoadResult,
} from '../task-file-boundaries.js';
import {
  captureNetRevertBaseline,
  checkForNetReverts,
  type NetRevertBaseline,
} from './net-revert-guard.js';
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
import type {
  ReviewMode,
  ReviewSnapshot,
  ReviewFindingRecord,
  FindingDisposition,
  ReviewDimensionState,
  DispositionHistoryEntry,
} from '../review-state/types.js';
import { fingerprintFinding } from '../review-state/fingerprint.js';
import {
  deriveAllowedFiles,
  assessChangedFiles,
  formatScopeWarning,
  buildFindingCommitMessage,
} from './review-fix-scope.js';
import {
  recordResolvedFindings,
  detectFindingRecurrence,
  type ResolvedFindingFingerprint,
} from './finding-recurrence-guard.js';
import {
  inspectFixCommitForOscillation,
  formatFileOscillationReason,
  type FileStateHistory,
  type FileOscillationMatch,
} from './file-oscillation-guard.js';

async function computeNewState(
  prevState: ReviewDimensionState | undefined,
  newFindings: Array<{ severity: string; summary: string }>,
  fixVerdict: 'done_with_fixes' | 'done_no_fixes_needed' | 'cannot_fix' | undefined,
  snapshot: ReviewSnapshot,
  now: Date,
): Promise<ReviewDimensionState> {
  const newFingerprints = new Set<string>();
  for (const f of newFindings) {
    const fp = await fingerprintFinding('integration', f.severity, f.summary);
    newFingerprints.add(fp);
  }
  const prevRecords = prevState?.unresolvedRecords ?? [];
  const prevDispositions = prevState?.dispositionHistory ?? [];

  const dispositionHistory = [...prevDispositions];
  const unresolvedRecords: ReviewFindingRecord[] = [];

  const dispByFp = new Map<string, DispositionHistoryEntry>();
  for (const h of dispositionHistory) {
    dispByFp.set(h.fingerprint, h);
  }

  for (const prev of prevRecords) {
    const stillPresent = newFingerprints.has(prev.fingerprint);
    if (stillPresent) {
      let disposition: FindingDisposition = 'open';
      if (fixVerdict === 'done_with_fixes' || fixVerdict === 'done_no_fixes_needed') {
        disposition = 'recurred';
      }
      unresolvedRecords.push(prev);
      const latestDisp = dispByFp.get(prev.fingerprint);
      if (!latestDisp || latestDisp.disposition !== disposition) {
        const newEntry: DispositionHistoryEntry = {
          fingerprint: prev.fingerprint,
          disposition,
          changedAt: now.toISOString(),
          ...(fixVerdict ? { reason: `Fixer returned ${fixVerdict} but finding recurred` } : {}),
        };
        dispositionHistory.push(newEntry);
        dispByFp.set(prev.fingerprint, newEntry);
      }
    } else {
      let disposition: FindingDisposition = 'settled';
      if (fixVerdict === 'done_with_fixes') {
        disposition = 'addressed';
      } else if (fixVerdict === 'done_no_fixes_needed') {
        disposition = 'rebutted';
      }
      const latestDisp = dispByFp.get(prev.fingerprint);
      if (!latestDisp || latestDisp.disposition !== disposition) {
        const newEntry: DispositionHistoryEntry = {
          fingerprint: prev.fingerprint,
          disposition,
          changedAt: now.toISOString(),
          ...(fixVerdict ? { reason: `Fixer returned ${fixVerdict} and finding resolved` } : {}),
        };
        dispositionHistory.push(newEntry);
        dispByFp.set(prev.fingerprint, newEntry);
      }
    }
  }

  for (const f of newFindings) {
    const fp = await fingerprintFinding('integration', f.severity, f.summary);
    const isBrandNew = !prevRecords.some((r) => r.fingerprint === fp);
    if (isBrandNew) {
      const record: ReviewFindingRecord = {
        reviewerKind: 'integration',
        severity: f.severity,
        summary: f.summary,
        fingerprint: fp,
      };
      unresolvedRecords.push(record);
      const newEntry: DispositionHistoryEntry = {
        fingerprint: fp,
        disposition: 'open',
        changedAt: now.toISOString(),
      };
      dispositionHistory.push(newEntry);
      dispByFp.set(fp, newEntry);
    }
  }

  return {
    dimension: 'integration',
    latestSnapshot: snapshot,
    latestVerdict: newFindings.length > 0 ? 'fail' : 'pass',
    dirty: newFindings.length > 0,
    provisionallyClean: newFindings.length === 0,
    unresolvedRecords,
    dispositionHistory,
  };
}

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

    const baseline = await captureNetRevertBaseline({
      ...(deps.git ? { git: deps.git } : {}),
      cwd: input.cwd,
      ...(input.baselineCommitSha ? { baselineCommitSha: input.baselineCommitSha } : {}),
    });

    const manifestResult = await this.loadManifest(input, {
      cwd: input.cwd,
      runId: input.runId,
    });

    let consecutiveFixFailures = 0;
    // Trackers for the optional runaway-protection caps (#667). Kept
    // separate from `consecutiveFixFailures` so we don't entangle
    // fallback-escalation semantics with the new exit conditions.
    let consecutiveFixFailuresForCap = 0;
    let totalFixAttempts = 0;
    let lastFixInvocationId: string | undefined;
    let lastFailingCategory: string | undefined;
    let lastIterationHadFixCommit = false;
    // Head range of the most recent fix commit, so a failing post-fix gate can be
    // attributed to that delta (automation#878).
    let lastFixHeadRange: { before: string; after: string } | undefined;
    let outstandingFailedRevalidation = false;
    let lastPostFixGateFailed = false;
    let lastOffendingFindings: Array<{ severity: string; summary: string; files?: string[] }> = [];
    const states = deps.reviewStateRepository?.listDimensionStates(
      String(input.runId),
      String(input.phaseId),
      String(input.phaseId),
    );
    let integrationState = states?.find((s) => s.dimension === 'integration');
    let lastReviewedCommitSha = integrationState?.latestSnapshot?.identity;
    let lastFixVerdict: 'done_with_fixes' | 'done_no_fixes_needed' | 'cannot_fix' | undefined;
    let pendingReconciliationContext: string | undefined;
    let lastReviewResult: ReviewStepResult | undefined;
    let arbiterAlreadyRuledValid = false;
    let pendingScopeReviewContext: string | undefined;
    let pendingDeterministicDiagnostic: string | undefined;
    const findingArrayHistory: Array<
      Array<{ severity: string; summary: string; files?: string[] }>
    > = [];
    const unfoundedPingPongHistory: FindingHistoryEntry[] = [];
    let headRevalidated = true;
    const resolvedFindingFingerprints = new Map<string, ResolvedFindingFingerprint>();
    let currentFixChangedFiles: string[] = [];
    const fileStateHistory: FileStateHistory = new Map();

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

    let preEvaluatedGateResult: PostFixGateResult | undefined;
    let thisLoop: Loop = loop;
    while (canStartReviewCycle(thisLoop)) {
      if (thisLoop.iterations.length === originalMax) {
        thisLoop = { ...thisLoop, maxIterations: thisLoop.iterations.length + 1 };
      }
      loop = thisLoop;
      const headRevalidatedAtStart = headRevalidated;
      const iterationIndex = loop.iterations.length + 1;
      const ctx: StepContext = {
        loopId: loop.id,
        runId: input.runId,
        phaseId: input.phaseId,
        repoId: input.repoId,
        cwd: input.cwd,
        iterationIndex,
      };

      const skippingRedundantReview =
        pendingReconciliationContext !== undefined && lastReviewResult !== undefined;
      let review: ReviewStepResult;

      let gateResult: PostFixGateResult | undefined;

      if (skippingRedundantReview) {
        review = lastReviewResult!;
        thisLoop = startIteration(thisLoop, {
          reviewInvocationId: review.invocationId,
          now: deps.now(),
        });
        deps.loops.update(thisLoop);
        this.emit(
          input,
          'review.bypassed_for_arbitration',
          'info',
          `bypassing redundant re-review at iteration ${iterationIndex} to route arbiter rationale directly to fix step`,
          { iterationIndex },
        );
      } else {
        arbiterAlreadyRuledValid = false;
        // --- POST-FIX GATE (skip iteration 1 — fixer has not yet committed) ---
        if (preEvaluatedGateResult) {
          gateResult = preEvaluatedGateResult;
          preEvaluatedGateResult = undefined;
          lastPostFixGateFailed = gateResult.outcome === 'fail';
        } else if (iterationIndex > 1 && lastIterationHadFixCommit) {
          gateResult = await deps.runPostFixGate(ctx);
          lastPostFixGateFailed = gateResult.outcome === 'fail';
        }
      }

      if (lastPostFixGateFailed && gateResult) {
        // Distinguish "the diff is wrong" from "the workspace is inconsistent".
        // Run 5b57a291 failed here on packages/domain typecheck errors that did
        // not reproduce, burning iterations on an environment fault
        // (automation#878). Classification is recorded so the two are
        // distinguishable in the run record.
        let lastFixChangedFiles: string[] | undefined;
        if (this.deps.git && lastFixHeadRange) {
          try {
            lastFixChangedFiles = await this.deps.git.changedFiles(
              ctx.cwd,
              lastFixHeadRange.before,
              lastFixHeadRange.after,
            );
          } catch {
            // Undetermined delta fails closed as a code defect.
            lastFixChangedFiles = undefined;
          }
        }
        const gateClassification = classifyPostFixGateFailure({
          output: gateResult.output,
          changedFiles: lastFixChangedFiles,
        });

        this.emit(
          input,
          'deterministic_fix',
          'warn',
          `post-fix gate failure: ${gateResult.output}`,
          {
            diagnostic: gateResult.output,
            classification: gateClassification.classification,
            ...(gateClassification.classification === 'workspace_inconsistency'
              ? {
                  reportingPackage: gateClassification.reportingPackage,
                  driftDiagnostic: gateClassification.diagnostic,
                }
              : {}),
            ...(lastFixChangedFiles ? { lastFixChangedFiles } : {}),
          },
        );

        if (gateClassification.classification === 'workspace_inconsistency') {
          this.emit(
            input,
            'loop.deterministic_gate.workspace_inconsistency',
            'warn',
            `post-fix gate failure attributed to workspace inconsistency in ${gateClassification.reportingPackage}, not to the diff under review`,
            {
              reportingPackage: gateClassification.reportingPackage,
              diagnostic: gateClassification.diagnostic,
              ...(lastFixChangedFiles ? { lastFixChangedFiles } : {}),
            },
          );
        }

        const fixerHistoryContext = await this.readHistoryContext(ctx, 'fixer', input);
        const escalateForFixFailures =
          consecutiveFixFailures >= 2 && input.fixFallbackProfile !== undefined;
        const useFallback = escalateForFixFailures;
        const allowedFiles = deriveAllowedFiles(lastOffendingFindings, input.cwd);
        const fix = await deps.runFix(ctx, {
          useFallback,
          ...(useFallback && lastFixInvocationId !== undefined
            ? { previousInvocationId: lastFixInvocationId }
            : {}),
          ...(input.architectPlan !== undefined ? { architectPlan: input.architectPlan } : {}),
          ...(fixerHistoryContext ? { historyContext: fixerHistoryContext } : {}),
          deterministicDiagnostic: gateResult.output,
          attemptKind: 'deterministic',
          ...(allowedFiles.length > 0 ? { allowedFiles } : {}),
        });
        lastFixInvocationId = fix.invocationId;
        lastFixVerdict = fix.verdict;

        thisLoop = startIteration(thisLoop, {
          kind: 'deterministic_fix',
          fixInvocationId: fix.invocationId,
          now: deps.now(),
        });
        deps.loops.update(thisLoop);

        if (
          fix.agentOutcome !== 'success' ||
          fix.verdict === undefined ||
          fix.verdict === 'cannot_fix'
        ) {
          consecutiveFixFailures += 1;
          consecutiveFixFailuresForCap += 1;
          lastIterationHadFixCommit = false;

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
          await this.appendHistoryEntry(ctx, {}, fix, undefined, outcome, input);
          await this.runCleanArtifacts(ctx);

          if (capHit) {
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

          this.emit(
            input,
            'loop.deterministic_gate.progress_halted',
            'error',
            `progress halted: deterministic gate continues to fail and fixer failed`,
            { iterationIndex },
          );
          thisLoop = exhaust(thisLoop, this.deps.now());
          this.deps.loops.update(thisLoop);
          return {
            loop: thisLoop,
            phaseOutcome: 'failed',
            loopStatus: 'failed',
            residualFindingsCount: lastOffendingFindings.length,
          };
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
          headRevalidated = false;
          lastPostFixGateFailed = false;
          totalFixAttempts += 1;

          if (this.deps.git && fix.headBeforeFix) {
            const verification = await verifyFixCommit({
              git: this.deps.git,
              cwd: ctx.cwd,
              expectedHead: fix.headBeforeFix,
            });
            if (verification.kind === 'advanced') {
              const boundaryCheck = await this.checkTaskBoundary(
                ctx,
                input,
                fix.headBeforeFix,
                verification.headAfterFix,
                manifestResult,
              );
              if (!boundaryCheck.ok) {
                const failure = await this.handleBoundaryFailure(
                  ctx,
                  input,
                  {},
                  fix,
                  boundaryCheck,
                  thisLoop,
                );
                if (!failure.handled) {
                  return failure.result;
                }
                thisLoop = failure.loop;
                const gateOutput = gateResult?.output
                  ? `${gateResult.output}\n\n${boundaryCheck.message}`
                  : boundaryCheck.message;
                preEvaluatedGateResult = { outcome: 'fail', output: gateOutput };
                consecutiveFixFailures = 0;
                consecutiveFixFailuresForCap = 0;
                lastIterationHadFixCommit = false;
                continue;
              }

              lastFixHeadRange = {
                before: fix.headBeforeFix,
                after: verification.headAfterFix,
              };
              const scopeResult = await this.finalizeScopeAndCommitMessage({
                ctx,
                loopInput: input,
                headBeforeFix: fix.headBeforeFix,
                headAfterFix: verification.headAfterFix,
                findings: lastOffendingFindings,
                ...(fix.outOfScopeReasons ? { reasons: fix.outOfScopeReasons } : {}),
              });
              currentFixChangedFiles = scopeResult.changedFiles;
              if (scopeResult.pendingScopeWarning) {
                pendingScopeReviewContext = scopeResult.pendingScopeWarning;
              }

              const oscillation = await this.checkFileOscillation({
                ctx,
                loopInput: input,
                headBeforeFix: fix.headBeforeFix,
                headAfterFix: scopeResult.headAfterFix,
                fixChangedFiles: currentFixChangedFiles,
                history: fileStateHistory,
              });
              if (oscillation.detected) {
                thisLoop = completeIteration(thisLoop, { outcome: 'failed', now: deps.now() });
                deps.loops.update(thisLoop);
                this.emitIterationCompleted(input, iterationIndex, 'failed');
                await this.appendHistoryEntry(ctx, {}, fix, undefined, 'failed', input);
                await this.runCleanArtifacts(ctx);
                return {
                  loop: thisLoop,
                  phaseOutcome: 'failed',
                  loopStatus: 'failed',
                  needsHumanReview: true,
                  humanReviewReason: oscillation.humanReviewReason,
                  residualFindingsCount: lastOffendingFindings.length,
                };
              }
            }
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

              const reval = await deps.runRevalidation(ctx);
              let autoCommitted = false;
              if (reval.passed) {
                const message = `fix: deterministic gate resolution (auto-committed)`;
                let committedSha: string | undefined;
                try {
                  await this.deps.git!.addAll(ctx.cwd);
                  committedSha = await this.deps.git!.commit(ctx.cwd, message);
                } catch {}
                if (committedSha) {
                  const boundaryCheck = await this.checkTaskBoundary(
                    ctx,
                    input,
                    fix.headBeforeFix ?? 'HEAD',
                    committedSha,
                    manifestResult,
                  );
                  if (!boundaryCheck.ok) {
                    const failure = await this.handleBoundaryFailure(
                      ctx,
                      input,
                      {},
                      fix,
                      boundaryCheck,
                      thisLoop,
                    );
                    if (!failure.handled) {
                      return failure.result;
                    }
                    thisLoop = failure.loop;
                    const gateOutput = gateResult?.output
                      ? `${gateResult.output}\n\n${boundaryCheck.message}`
                      : boundaryCheck.message;
                    preEvaluatedGateResult = { outcome: 'fail', output: gateOutput };
                    consecutiveFixFailures = 0;
                    consecutiveFixFailuresForCap = 0;
                    lastIterationHadFixCommit = false;
                    continue;
                  }

                  const scopeResult = await this.finalizeScopeAndCommitMessage({
                    ctx,
                    loopInput: input,
                    headBeforeFix: fix.headBeforeFix ?? 'HEAD',
                    headAfterFix: committedSha,
                    findings: lastOffendingFindings,
                    ...(fix.outOfScopeReasons ? { reasons: fix.outOfScopeReasons } : {}),
                  });
                  currentFixChangedFiles = scopeResult.changedFiles;
                  if (scopeResult.pendingScopeWarning) {
                    pendingScopeReviewContext = scopeResult.pendingScopeWarning;
                  }

                  const oscillation = await this.checkFileOscillation({
                    ctx,
                    loopInput: input,
                    headBeforeFix: fix.headBeforeFix ?? 'HEAD',
                    headAfterFix: scopeResult.headAfterFix,
                    fixChangedFiles: currentFixChangedFiles,
                    history: fileStateHistory,
                  });
                  if (oscillation.detected) {
                    thisLoop = completeIteration(thisLoop, { outcome: 'failed', now: deps.now() });
                    deps.loops.update(thisLoop);
                    this.emitIterationCompleted(input, iterationIndex, 'failed');
                    await this.appendHistoryEntry(ctx, {}, fix, undefined, 'failed', input);
                    await this.runCleanArtifacts(ctx);
                    return {
                      loop: thisLoop,
                      phaseOutcome: 'failed',
                      loopStatus: 'failed',
                      needsHumanReview: true,
                      humanReviewReason: oscillation.humanReviewReason,
                      residualFindingsCount: lastOffendingFindings.length,
                    };
                  }
                  autoCommitted = true;
                  lastIterationHadFixCommit = true;
                  headRevalidated = false;
                  consecutiveFixFailures = 0;
                  consecutiveFixFailuresForCap = 0;
                  totalFixAttempts += 1;

                  await recordResolvedFindings({
                    resolvedMap: resolvedFindingFingerprints,
                    findings: lastOffendingFindings,
                    fixChangedFiles: currentFixChangedFiles,
                    iterationIndex,
                    cwd: ctx.cwd,
                  });

                  thisLoop = completeIteration(thisLoop, {
                    outcome: 'fixed',
                    fixInvocationId: fix.invocationId,
                    revalidationId: reval.validationRunId,
                    now: deps.now(),
                  });
                  deps.loops.update(thisLoop);
                  this.emitIterationCompleted(input, iterationIndex, 'fixed');
                  await this.appendHistoryEntry(ctx, {}, fix, reval, 'fixed', input);
                  continue;
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
                await this.appendHistoryEntry(ctx, {}, fix, reval, 'unresolved', input, {
                  kind: 'uncommitted_changes',
                  dirtyFiles: verification.dirtyFiles,
                  statusOutput: verification.statusOutput,
                });
                await this.runCleanArtifacts(ctx);

                this.emit(
                  input,
                  'loop.deterministic_gate.progress_halted',
                  'error',
                  `progress halted: deterministic gate continues to fail and uncommitted changes could not be auto-committed`,
                  { iterationIndex },
                );
                thisLoop = exhaust(thisLoop, this.deps.now());
                this.deps.loops.update(thisLoop);
                return {
                  loop: thisLoop,
                  phaseOutcome: 'failed',
                  loopStatus: 'failed',
                  residualFindingsCount: lastOffendingFindings.length,
                };
              }
            } else if (verification.kind === 'no_commit_claimed') {
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
              await this.appendHistoryEntry(ctx, {}, fix, undefined, 'unresolved', input, {
                kind: 'no_commit_claimed',
                statusOutput: verification.statusOutput,
              });
              await this.runCleanArtifacts(ctx);

              this.emit(
                input,
                'loop.deterministic_gate.progress_halted',
                'error',
                `progress halted: deterministic gate continues to fail and no commit was made`,
                { iterationIndex },
              );
              thisLoop = exhaust(thisLoop, this.deps.now());
              this.deps.loops.update(thisLoop);
              return {
                loop: thisLoop,
                phaseOutcome: 'failed',
                loopStatus: 'failed',
                residualFindingsCount: lastOffendingFindings.length,
              };
            }
          }
        }

        const nextGateResult = await deps.runPostFixGate(ctx);
        lastPostFixGateFailed = nextGateResult.outcome === 'fail';
        preEvaluatedGateResult = nextGateResult;

        let reval: RevalidationResult | undefined;
        if (!lastPostFixGateFailed) {
          reval = await deps.runRevalidation(ctx);
          outstandingFailedRevalidation = !reval.passed;
          headRevalidated = reval.passed;
        }

        const iterationOutcome = !lastPostFixGateFailed && reval?.passed ? 'fixed' : 'unresolved';
        if (iterationOutcome === 'fixed') {
          await recordResolvedFindings({
            resolvedMap: resolvedFindingFingerprints,
            findings: lastOffendingFindings,
            fixChangedFiles: currentFixChangedFiles,
            iterationIndex,
            cwd: ctx.cwd,
          });
        }
        thisLoop = completeIteration(thisLoop, {
          outcome: iterationOutcome,
          fixInvocationId: fix.invocationId,
          ...(reval ? { revalidationId: reval.validationRunId } : {}),
          now: deps.now(),
        });
        deps.loops.update(thisLoop);
        this.emitIterationCompleted(input, iterationIndex, iterationOutcome);
        await this.appendHistoryEntry(ctx, {}, fix, reval, iterationOutcome, input);

        const totalCap = input.maxTotalFixAttempts;
        if (totalCap !== undefined && totalCap > 0 && totalFixAttempts >= totalCap) {
          this.emit(
            input,
            'loop.exhausted.fix_attempt_cap',
            'warn',
            `review/fix loop exhausted: ${totalFixAttempts} productive fix attempts (cap=${totalCap})`,
            { iterationIndex, totalFixAttempts, cap: totalCap },
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

        if (!lastIterationHadFixCommit && lastPostFixGateFailed) {
          this.emit(
            input,
            'loop.deterministic_gate.progress_halted',
            'error',
            `progress halted: deterministic gate continues to fail and no progress was made`,
            { iterationIndex },
          );
          thisLoop = exhaust(thisLoop, this.deps.now());
          this.deps.loops.update(thisLoop);
          return {
            loop: thisLoop,
            phaseOutcome: 'failed',
            loopStatus: 'failed',
            residualFindingsCount: lastOffendingFindings.length,
          };
        }

        continue;
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
      let combinedHistoryContext = historyContext;
      if (pendingScopeReviewContext) {
        combinedHistoryContext = historyContext
          ? `${historyContext}\n\n${pendingScopeReviewContext}`
          : pendingScopeReviewContext;
      }
      pendingScopeReviewContext = undefined;

      let branchCreatedFiles: string[] = [];
      if (deps.git && input.baselineCommitSha) {
        try {
          const raw = await deps.git.createdFiles(input.cwd, input.baselineCommitSha, 'HEAD');
          branchCreatedFiles = Array.from(
            new Set(raw.map((f) => f.replace(/\\/g, '/').trim()).filter(Boolean)),
          ).sort();
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const failedLoop: Loop = {
            ...thisLoop,
            status: 'failed',
            completedAt: deps.now(),
          };
          deps.loops.update(failedLoop);
          this.emit(
            input,
            'loop.created_files_check_failed',
            'error',
            `branch-created files check failed against base ${input.baselineCommitSha}: ${errorMsg}`,
            {
              baselineCommitSha: input.baselineCommitSha,
              error: errorMsg,
            },
          );
          return {
            loop: failedLoop,
            phaseOutcome: 'failed',
            loopStatus: 'failed',
            needsHumanReview: true,
          };
        }
      }

      const reviewMode: ReviewMode =
        iterationIndex === 1 ? 'integration_full' : 'intermediate_delta';
      if (!skippingRedundantReview) {
        const reviewOptions = {
          ...(gateResult && gateResult.outcome === 'pass' ? { gateResult } : {}),
          ...(combinedHistoryContext ? { historyContext: combinedHistoryContext } : {}),
          ...(iterationIndex >= 2 && lastReviewedCommitSha && (opts.deltaScopedReReview ?? true)
            ? { prevReviewedCommitSha: lastReviewedCommitSha }
            : {}),
          ...(deps.reviewStateRepository !== undefined
            ? {
                mode: reviewMode,
                unresolvedRecords: integrationState?.unresolvedRecords ?? [],
                dispositionHistory: integrationState?.dispositionHistory ?? [],
              }
            : {}),
          ...(branchCreatedFiles.length > 0 ? { createdFiles: branchCreatedFiles } : {}),
        };
        ctx.metadata = {
          iteration: iterationIndex,
          invocation_type: iterationIndex === 1 ? 'initial' : 'semantic_retry',
          reviewMode,
        };
        review = await deps.runReview(
          ctx,
          Object.keys(reviewOptions).length > 0 ? reviewOptions : undefined,
        );

        if (review.verdict === undefined && review.classification === 'serialization_artifact') {
          this.emit(
            input,
            'review.artifact_recovery_retry',
            'warn',
            `retrying serialization artifact failure in review loop iteration ${iterationIndex}`,
            {
              iterationIndex,
              previousInvocationId: review.invocationId,
              violationCode: review.violationCode,
            },
          );
          await this.runCleanArtifacts(ctx);
          review = await deps.runReview(ctx, {
            ...reviewOptions,
            artifactRecoveryRetry: true,
          });
        }
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
        lastReviewResult = review;
      }

      if (review.agentOutcome !== 'success' || review.verdict === undefined) {
        thisLoop = completeIteration(thisLoop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(thisLoop);
        this.emitIterationCompleted(input, iterationIndex, 'failed');
        await this.appendHistoryEntry(ctx, review, undefined, undefined, 'failed', input);
        await this.runCleanArtifacts(ctx);
        break;
      }

      const rawFindings = review.offendingFindings ?? [];
      const recurrence = await detectFindingRecurrence({
        resolvedFindings: resolvedFindingFingerprints,
        rawFindings,
        currentIteration: iterationIndex,
      });

      if (recurrence) {
        const humanReviewReason = `review finding "${recurrence.resolved.summary}" recurred at iteration ${iterationIndex} after being resolved in iteration ${recurrence.resolved.resolvedInIteration}; human adjudication required`;
        this.emit(input, 'loop.exhausted.finding_recurrence', 'warn', humanReviewReason, {
          iterationIndex,
          fingerprint: recurrence.resolved.fingerprint,
          summary: recurrence.resolved.summary,
          resolvedInIteration: recurrence.resolved.resolvedInIteration,
          recurringInIteration: iterationIndex,
          fixChangedFiles: recurrence.resolved.fixChangedFiles,
          files: recurrence.recurringFinding.files ?? [],
          findingFiles: recurrence.recurringFinding.files ?? [],
        });

        thisLoop = completeIteration(thisLoop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(thisLoop);
        this.emitIterationCompleted(input, iterationIndex, 'failed');
        await this.appendHistoryEntry(ctx, review, undefined, undefined, 'failed', input);
        await this.runCleanArtifacts(ctx);

        return {
          loop: thisLoop,
          phaseOutcome: 'failed',
          loopStatus: 'failed',
          needsHumanReview: true,
          humanReviewReason,
          residualFindingsCount: rawFindings.length,
        };
      }

      if (review.verdict === 'pass') {
        if (deps.reviewStateRepository) {
          const snapshot: ReviewSnapshot = {
            kind: 'git',
            identity: review.reviewedCommitSha || '',
            capturedAt: deps.now().toISOString(),
          };
          const nextState = await computeNewState(
            integrationState,
            [],
            lastFixVerdict,
            snapshot,
            deps.now(),
          );
          deps.reviewStateRepository.appendAttempt({
            attemptId: review.invocationId,
            runId: String(input.runId),
            scope: String(input.phaseId),
            step: String(input.phaseId),
            reviewMode,
            dimension: 'integration',
            snapshot,
            verdict: review.verdict,
            createdAt: deps.now().toISOString(),
            artifacts: [],
          });
          deps.reviewStateRepository.upsertDimensionState(
            String(input.runId),
            String(input.phaseId),
            String(input.phaseId),
            nextState,
          );
          integrationState = nextState;
          lastReviewedCommitSha = snapshot.identity;
        }

        if (outstandingFailedRevalidation || !headRevalidated) {
          const reval = await deps.runRevalidation(ctx);
          outstandingFailedRevalidation = !reval.passed;
          headRevalidated = reval.passed;
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

      // --- STRUCTURAL EVIDENCE CHECK & FILTERING (Step 2) ---
      const originalFindings = review.offendingFindings ?? [];
      const unfoundedList = await this.checkReviewerEvidence(input, review, iterationIndex);
      const unfoundedFingerprints = fingerprintFindings(unfoundedList);
      const groundedFindings = originalFindings.filter(
        (finding) => !unfoundedFingerprints.has(fingerprintSingleFinding(finding)),
      );

      if (unfoundedList.length > 0) {
        this.emit(
          input,
          'review.evidence.dropped',
          'warn',
          `dropped ${unfoundedList.length} unfounded reviewer finding(s)`,
          {
            iterationIndex,
            droppedCount: unfoundedList.length,
            remainingCount: groundedFindings.length,
            dropped: unfoundedList.map((u) => ({
              severity: u.severity,
              summary: u.summary,
              ...(u.evidence ? { evidence: u.evidence } : {}),
            })),
          },
        );
      }

      review = {
        ...review,
        offendingFindings: groundedFindings,
      };
      lastOffendingFindings = groundedFindings;

      // --- ALL-DROPPED NO-OP TRANSITION (Step 3) ---
      if (originalFindings.length > 0 && groundedFindings.length === 0) {
        lastIterationHadFixCommit = false;
        const reval = await deps.runRevalidation(ctx);
        if (reval.passed) {
          thisLoop = completeIteration(thisLoop, { outcome: 'resolved', now: deps.now() });
          deps.loops.update(thisLoop);
          this.emitIterationCompleted(input, iterationIndex, 'resolved');
          await this.appendHistoryEntry(ctx, review, undefined, reval, 'resolved', input);
          return await this.finalizeOutcome(input, baseline, {
            loop: thisLoop,
            phaseOutcome: 'passed',
            loopStatus: 'converged',
          });
        }
        outstandingFailedRevalidation = true;
        lastIterationHadFixCommit = false;
      }

      if (deps.reviewStateRepository) {
        const snapshot: ReviewSnapshot = {
          kind: 'git',
          identity: review.reviewedCommitSha || '',
          capturedAt: deps.now().toISOString(),
        };
        const nextState = await computeNewState(
          integrationState,
          groundedFindings,
          lastFixVerdict,
          snapshot,
          deps.now(),
        );
        deps.reviewStateRepository.appendAttempt({
          attemptId: review.invocationId,
          runId: String(input.runId),
          scope: String(input.phaseId),
          step: String(input.phaseId),
          reviewMode,
          dimension: 'integration',
          snapshot,
          verdict: review.verdict ?? 'fail',
          createdAt: deps.now().toISOString(),
          artifacts: [],
        });
        deps.reviewStateRepository.upsertDimensionState(
          String(input.runId),
          String(input.phaseId),
          String(input.phaseId),
          nextState,
        );
        integrationState = nextState;
        lastReviewedCommitSha = snapshot.identity;
      }

      // --- OSCILLATION / STALL DETECTION (Step 4) ---
      findingArrayHistory.push(groundedFindings);
      if (findingArrayHistory.length > 3) {
        findingArrayHistory.splice(0, findingArrayHistory.length - 3);
      }
      const findingHistory = findingArrayHistory.map((arr) => fingerprintFindings(arr));
      const stall = detectStall(findingHistory);

      if (stall === 'oscillation' && findingArrayHistory.length >= 3) {
        const currentFindings = groundedFindings;
        const middleFindings = findingArrayHistory[findingArrayHistory.length - 2]!;
        const prevPrevFindings = findingArrayHistory[findingArrayHistory.length - 3]!;

        const currentFps = fingerprintFindings(currentFindings);
        const middleFps = fingerprintFindings(middleFindings);
        const prevPrevFps = fingerprintFindings(prevPrevFindings);

        const demandA = currentFindings.find((f) => {
          const fp = fingerprintSingleFinding(f);
          return prevPrevFps.has(fp) && !middleFps.has(fp);
        });

        if (demandA) {
          const candidatesB = middleFindings.filter((f) => {
            const fp = fingerprintSingleFinding(f);
            return !currentFps.has(fp);
          });

          if (candidatesB.length > 0) {
            const filesA = new Set(
              (demandA.files ?? []).map((f) => f.replace(/\\/g, '/').trim().toLowerCase()),
            );
            const candidatesWithOverlap = candidatesB.filter((fB) =>
              (fB.files ?? []).some((f) => filesA.has(f.replace(/\\/g, '/').trim().toLowerCase())),
            );
            const demandB =
              candidatesWithOverlap.length > 0 ? candidatesWithOverlap[0]! : candidatesB[0]!;

            const humanReviewReason =
              `review/fix oscillation detected between "${demandA.summary}" and ` +
              `"${demandB.summary}"; human adjudication required`;

            const sharedFiles = (demandA.files ?? []).filter((fA) =>
              (demandB.files ?? []).some(
                (fB) =>
                  fA.replace(/\\/g, '/').trim().toLowerCase() ===
                  fB.replace(/\\/g, '/').trim().toLowerCase(),
              ),
            );

            const fpA = fingerprintSingleFinding(demandA);
            const fpB = fingerprintSingleFinding(demandB);

            this.emit(input, 'review.oscillation.detected', 'warn', humanReviewReason, {
              iterationIndex,
              demandA: demandA.summary,
              demandASummary: demandA.summary,
              demandAFingerprint: fpA,
              demandB: demandB.summary,
              demandBSummary: demandB.summary,
              demandBFingerprint: fpB,
              ...(sharedFiles.length > 0 ? { sharedFiles } : {}),
            });

            thisLoop = completeIteration(thisLoop, { outcome: 'failed', now: deps.now() });
            deps.loops.update(thisLoop);
            this.emitIterationCompleted(input, iterationIndex, 'failed');
            await this.appendHistoryEntry(ctx, review, undefined, undefined, 'failed', input);

            return {
              loop: thisLoop,
              phaseOutcome: 'failed',
              loopStatus: 'failed',
              needsHumanReview: true,
              humanReviewReason,
              residualFindingsCount: groundedFindings.length,
            };
          }
        }
      }

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
      const allowedFiles = deriveAllowedFiles(groundedFindings, input.cwd);
      const fix = await deps.runFix(ctx, {
        useFallback,
        ...(useFallback && lastFixInvocationId !== undefined
          ? { previousInvocationId: lastFixInvocationId }
          : {}),
        ...(input.architectPlan !== undefined ? { architectPlan: input.architectPlan } : {}),
        ...(fixerHistoryContext ? { historyContext: fixerHistoryContext } : {}),
        ...(pendingReconciliationContext
          ? { reconciliationContext: pendingReconciliationContext }
          : {}),
        ...(pendingDeterministicDiagnostic
          ? { deterministicDiagnostic: pendingDeterministicDiagnostic }
          : {}),
        ...(allowedFiles.length > 0 ? { allowedFiles } : {}),
      });
      pendingReconciliationContext = undefined;
      pendingDeterministicDiagnostic = undefined;
      lastFixInvocationId = fix.invocationId;
      lastFixVerdict = fix.verdict;

      if (
        fix.agentOutcome !== 'success' ||
        fix.verdict === undefined ||
        fix.verdict === 'cannot_fix'
      ) {
        consecutiveFixFailures += 1;
        consecutiveFixFailuresForCap += 1;
        lastIterationHadFixCommit = false;

        unfoundedPingPongHistory.push({
          findings: unfoundedFingerprints,
          ...(fix.verdict ? { fixerVerdict: fix.verdict } : {}),
        });

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

      unfoundedPingPongHistory.push({
        findings: unfoundedFingerprints,
        ...(fix.verdict ? { fixerVerdict: fix.verdict } : {}),
      });

      const unfoundedLimit = deps.unfoundedPingPongLimit ?? 4;
      if (detectUnfoundedPingPong(unfoundedPingPongHistory, unfoundedLimit)) {
        const humanReviewReason = `unfounded finding ping-pong detected across ${unfoundedLimit} iterations; human adjudication required`;
        this.emit(input, 'review.unfounded_pingpong.detected', 'warn', humanReviewReason, {
          iterationIndex,
          unfoundedCount: unfoundedList.length,
          limit: unfoundedLimit,
        });
        thisLoop = completeIteration(thisLoop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(thisLoop);
        this.emitIterationCompleted(input, iterationIndex, 'failed');
        await this.appendHistoryEntry(ctx, review, fix, undefined, 'failed', input);

        return {
          loop: thisLoop,
          phaseOutcome: 'failed',
          loopStatus: 'failed',
          needsHumanReview: true,
          humanReviewReason,
          residualFindingsCount: groundedFindings.length,
        };
      }

      // --- FAST-TRACK CONTRADICTION ADJUDICATION ---
      if (fix.verdict === 'done_no_fixes_needed' && deps.runArbiter !== undefined) {
        if (arbiterAlreadyRuledValid) {
          this.emit(
            input,
            'needs_human_review',
            'warn',
            `fixer declined to fix finding at iteration ${iterationIndex} despite prior arbiter ruling finding_valid — escalating to human`,
            { iterationIndex },
          );
          thisLoop = completeIteration(thisLoop, { outcome: 'failed', now: deps.now() });
          deps.loops.update(thisLoop);
          return {
            loop: thisLoop,
            phaseOutcome: 'failed',
            loopStatus: 'failed',
            needsHumanReview: true,
            residualFindingsCount: lastOffendingFindings.length,
          };
        }

        this.emit(
          input,
          'review.contradiction.escalated',
          'warn',
          `escalating review/fix contradiction to arbiter at iteration ${iterationIndex}`,
          {
            toProfile: 'arbiter',
            reason: 'contradiction_not_resolved_by_rerun',
            iterationIndex,
          },
        );
        const arbiterResult = await deps.runArbiter(
          {
            ...ctx,
            metadata: {
              iteration: iterationIndex,
              invocation_type: 'initial',
            },
          },
          review,
          fix,
        );

        if (
          !arbiterResult.evidence ||
          arbiterResult.evidence.trim().length === 0 ||
          arbiterResult.outcome === 'insufficient_evidence' ||
          arbiterResult.outcome === 'ambiguous'
        ) {
          this.emit(
            input,
            'needs_human_review',
            'warn',
            `arbiter did not resolve contradiction at iteration ${iterationIndex} — escalating to human`,
            { iterationIndex, outcome: arbiterResult.outcome },
          );
          thisLoop = completeIteration(thisLoop, { outcome: 'failed', now: deps.now() });
          deps.loops.update(thisLoop);
          return {
            loop: thisLoop,
            phaseOutcome: 'failed',
            loopStatus: 'failed',
            needsHumanReview: true,
            residualFindingsCount: lastOffendingFindings.length,
          };
        }

        if (arbiterResult.outcome === 'finding_invalid') {
          this.emit(
            input,
            'review.contradiction.resolved',
            'info',
            `arbiter resolved contradiction at iteration ${iterationIndex}: ${arbiterResult.outcome}`,
            {
              ruling: arbiterResult.outcome,
              evidence: arbiterResult.evidence,
              iterationIndex,
            },
          );
          if (this.deps.artifactStore) {
            await appendRebuttalToCodeReview(this.deps.artifactStore, {
              runId: String(input.runId),
              phaseId: String(input.phaseId),
              iterationIndex,
              rebuttal: fix.rebuttal ?? '(no rebuttal text provided)',
              unfoundedFindings: (review.offendingFindings ?? []).map((f) => ({
                severity: f.severity,
                summary: f.summary,
              })),
            });
          }
          const reval = await deps.runRevalidation(ctx);
          const iterationOutcome = reval.passed ? 'resolved' : 'unresolved';
          thisLoop = completeIteration(thisLoop, {
            outcome: iterationOutcome,
            fixInvocationId: fix.invocationId,
            revalidationId: reval.validationRunId,
            now: this.deps.now(),
          });
          deps.loops.update(thisLoop);
          this.emitIterationCompleted(input, iterationIndex, iterationOutcome);
          await this.appendHistoryEntry(ctx, review, fix, reval, iterationOutcome, input);
          if (iterationOutcome === 'resolved') {
            return await this.finalizeOutcome(input, baseline, {
              loop: thisLoop,
              phaseOutcome: 'passed',
              loopStatus: 'converged',
            });
          }
          continue;
        }

        if (arbiterResult.outcome === 'finding_valid') {
          this.emit(
            input,
            'review.contradiction.resolved',
            'info',
            `arbiter resolved contradiction at iteration ${iterationIndex}: ${arbiterResult.outcome}`,
            {
              ruling: arbiterResult.outcome,
              evidence: arbiterResult.evidence,
              iterationIndex,
            },
          );
          pendingReconciliationContext = arbiterResult.rationale;
          arbiterAlreadyRuledValid = true;
          thisLoop = completeIteration(thisLoop, {
            outcome: 'unresolved',
            fixInvocationId: fix.invocationId,
            now: deps.now(),
          });
          deps.loops.update(thisLoop);
          await this.appendHistoryEntry(ctx, review, fix, undefined, 'unresolved', input);
          this.emitIterationCompleted(input, iterationIndex, 'unresolved');
          consecutiveFixFailures = 0;
          continue;
        }
      }

      if (fix.verdict === 'done_with_fixes') {
        headRevalidated = false;
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
          if (verification.kind === 'advanced') {
            const boundaryCheck = await this.checkTaskBoundary(
              ctx,
              input,
              fix.headBeforeFix,
              verification.headAfterFix,
              manifestResult,
            );
            if (!boundaryCheck.ok) {
              const failure = await this.handleBoundaryFailure(
                ctx,
                input,
                review,
                fix,
                boundaryCheck,
                thisLoop,
              );
              if (!failure.handled) {
                return failure.result;
              }
              thisLoop = failure.loop;
              pendingDeterministicDiagnostic = boundaryCheck.message;
              consecutiveFixFailures = 0;
              consecutiveFixFailuresForCap = 0;
              lastIterationHadFixCommit = false;
              continue;
            }

            const scopeResult = await this.finalizeScopeAndCommitMessage({
              ctx,
              loopInput: input,
              headBeforeFix: fix.headBeforeFix,
              headAfterFix: verification.headAfterFix,
              findings: review.offendingFindings ?? [],
              ...(fix.outOfScopeReasons ? { reasons: fix.outOfScopeReasons } : {}),
            });
            currentFixChangedFiles = scopeResult.changedFiles;
            if (scopeResult.pendingScopeWarning) {
              pendingScopeReviewContext = scopeResult.pendingScopeWarning;
            }

            const oscillation = await this.checkFileOscillation({
              ctx,
              loopInput: input,
              headBeforeFix: fix.headBeforeFix,
              headAfterFix: scopeResult.headAfterFix,
              fixChangedFiles: currentFixChangedFiles,
              history: fileStateHistory,
            });
            if (oscillation.detected) {
              thisLoop = completeIteration(thisLoop, { outcome: 'failed', now: deps.now() });
              deps.loops.update(thisLoop);
              this.emitIterationCompleted(input, iterationIndex, 'failed');
              await this.appendHistoryEntry(ctx, review, fix, undefined, 'failed', input);
              await this.runCleanArtifacts(ctx);
              return {
                loop: thisLoop,
                phaseOutcome: 'failed',
                loopStatus: 'failed',
                needsHumanReview: true,
                humanReviewReason: oscillation.humanReviewReason,
                residualFindingsCount: lastOffendingFindings.length,
              };
            }
          }
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
                  await this.deps.git!.addAll(ctx.cwd);
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
                const boundaryCheck = await this.checkTaskBoundary(
                  ctx,
                  input,
                  fix.headBeforeFix ?? 'HEAD',
                  committedSha,
                  manifestResult,
                );
                if (!boundaryCheck.ok) {
                  const failure = await this.handleBoundaryFailure(
                    ctx,
                    input,
                    review,
                    fix,
                    boundaryCheck,
                    thisLoop,
                  );
                  if (!failure.handled) {
                    return failure.result;
                  }
                  thisLoop = failure.loop;
                  pendingDeterministicDiagnostic = boundaryCheck.message;
                  consecutiveFixFailures = 0;
                  consecutiveFixFailuresForCap = 0;
                  lastIterationHadFixCommit = false;
                  continue;
                }

                const scopeResult = await this.finalizeScopeAndCommitMessage({
                  ctx,
                  loopInput: input,
                  headBeforeFix: fix.headBeforeFix ?? 'HEAD',
                  headAfterFix: committedSha,
                  findings: review.offendingFindings ?? [],
                  ...(fix.outOfScopeReasons ? { reasons: fix.outOfScopeReasons } : {}),
                });
                currentFixChangedFiles = scopeResult.changedFiles;
                if (scopeResult.pendingScopeWarning) {
                  pendingScopeReviewContext = scopeResult.pendingScopeWarning;
                }

                const oscillation = await this.checkFileOscillation({
                  ctx,
                  loopInput: input,
                  headBeforeFix: fix.headBeforeFix ?? 'HEAD',
                  headAfterFix: scopeResult.headAfterFix,
                  fixChangedFiles: currentFixChangedFiles,
                  history: fileStateHistory,
                });
                if (oscillation.detected) {
                  thisLoop = completeIteration(thisLoop, { outcome: 'failed', now: deps.now() });
                  deps.loops.update(thisLoop);
                  this.emitIterationCompleted(input, iterationIndex, 'failed');
                  await this.appendHistoryEntry(ctx, review, fix, undefined, 'failed', input);
                  await this.runCleanArtifacts(ctx);
                  return {
                    loop: thisLoop,
                    phaseOutcome: 'failed',
                    loopStatus: 'failed',
                    needsHumanReview: true,
                    humanReviewReason: oscillation.humanReviewReason,
                    residualFindingsCount: lastOffendingFindings.length,
                  };
                }
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
                headRevalidated = false;
                consecutiveFixFailures = 0;
                consecutiveFixFailuresForCap = 0;
                totalFixAttempts += 1;
                if (review.reviewedCommitSha) {
                  lastReviewedCommitSha = review.reviewedCommitSha;
                }

                await recordResolvedFindings({
                  resolvedMap: resolvedFindingFingerprints,
                  findings: review.offendingFindings ?? [],
                  fixChangedFiles: currentFixChangedFiles,
                  iterationIndex,
                  cwd: ctx.cwd,
                });

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
      headRevalidated = reval.passed;

      // When revalidation fails after a fix that advanced HEAD, roll back
      // the fix commit so the next iteration starts from the pre-fix baseline
      // rather than a commit already known to break validation. This prevents
      // an exhausted loop or resumed run from inheriting unvalidated changes.
      if (!reval.passed && fix.headBeforeFix && deps.rollbackFix) {
        await deps.rollbackFix(ctx, fix.headBeforeFix);
        headRevalidated = headRevalidatedAtStart;
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


      // Default path: complete the iteration as fixed or unresolved.
      const iterationOutcome = reval.passed ? 'fixed' : 'unresolved';
      if (iterationOutcome === 'fixed') {
        await recordResolvedFindings({
          resolvedMap: resolvedFindingFingerprints,
          findings: review.offendingFindings ?? [],
          fixChangedFiles: currentFixChangedFiles,
          iterationIndex,
          cwd: ctx.cwd,
        });
      }
      thisLoop = completeIteration(thisLoop, {
        outcome: iterationOutcome,
        fixInvocationId: fix.invocationId,
        revalidationId: reval.validationRunId,
        now: deps.now(),
      });
      deps.loops.update(thisLoop);
      this.emitIterationCompleted(input, iterationIndex, iterationOutcome);

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
      return await this.finalizeOutcome(input, baseline, {
        loop,
        phaseOutcome: 'passed',
        loopStatus: 'converged',
      });
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
        return await this.finalizeOutcome(input, baseline, {
          loop,
          phaseOutcome: 'passed',
          loopStatus: 'converged_with_notes',
          needsHumanReview: true,
          residualFindingsCount: residualFindings.length,
        });
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

  private async finalizeOutcome(
    input: ReviewFixLoopInput,
    baseline: NetRevertBaseline,
    candidate: ReviewFixLoopResult,
  ): Promise<ReviewFixLoopResult> {
    const check = await checkForNetReverts({
      ...(this.deps.git ? { git: this.deps.git } : {}),
      cwd: input.cwd,
      baseline,
    });

    if (check.kind === 'pass') return candidate;

    const failedLoop = {
      ...candidate.loop,
      status: 'failed' as const,
      completedAt: this.deps.now(),
    };
    this.deps.loops.update(failedLoop);

    if (check.kind === 'reverted') {
      this.emit(
        input,
        'review_fix.net_revert_detected',
        'warn',
        `net revert detected: ${check.revertedFiles.length} file(s) restored to baseline`,
        {
          baselineCommitSha: baseline.kind === 'captured' ? baseline.baselineCommitSha : undefined,
          targetFiles: baseline.kind === 'captured' ? baseline.targetFiles : [],
          currentChangedFiles: [...check.currentChangedFiles].sort(),
          revertedFiles: [...check.revertedFiles].sort(),
        },
      );
    } else if (check.kind === 'indeterminate') {
      this.emit(
        input,
        'review_fix.net_revert_check_failed',
        'error',
        `net revert check failed at ${check.stage} stage: ${check.error}`,
        {
          stage: check.stage,
          error: check.error,
        },
      );
    }

    return {
      loop: failedLoop,
      phaseOutcome: 'failed',
      loopStatus: 'failed',
      needsHumanReview: true,
      ...(candidate.residualFindingsCount !== undefined
        ? { residualFindingsCount: candidate.residualFindingsCount }
        : {}),
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
    review: Partial<ReviewStepResult>,
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
          ...(review.classification !== undefined ? { classification: review.classification } : {}),
          ...(review.violationCode !== undefined ? { violationCode: review.violationCode } : {}),
          ...(review.detail !== undefined ? { detail: review.detail } : {}),
        },
        ...(fix
          ? {
              fix: {
                ...(fix.verdict !== undefined ? { verdict: fix.verdict } : {}),
                ...(fix.invocationId !== undefined ? { invocationId: fix.invocationId } : {}),
                ...(fix.headBeforeFix !== undefined ? { headBeforeFix: fix.headBeforeFix } : {}),
                ...(fix.summary !== undefined ? { summary: fix.summary } : {}),
                ...(fix.rebuttal !== undefined ? { rebuttal: fix.rebuttal } : {}),
                ...(fix.classification !== undefined ? { classification: fix.classification } : {}),
                ...(fix.violationCode !== undefined ? { violationCode: fix.violationCode } : {}),
                ...(fix.detail !== undefined ? { detail: fix.detail } : {}),
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
    if (!markdown && this.deps.readWorktreeFile && input.cwd) {
      try {
        markdown = (await this.deps.readWorktreeFile(input.cwd, 'code-review.md')) ?? '';
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
      let matched = evidence.filter((e) => {
        if (!e.path) return false;
        const summaryLc = f.summary.toLowerCase();
        const basename = e.path.split('/').pop()?.toLowerCase();
        const fFiles = f.files ?? [];
        if (basename !== undefined && summaryLc.includes(basename)) return true;
        if (
          fFiles.some(
            (file) =>
              file.toLowerCase() === e.path.toLowerCase() ||
              (basename !== undefined && file.toLowerCase().endsWith(basename)),
          )
        ) {
          return true;
        }
        return false;
      });

      if (matched.length === 0) {
        const fFiles = f.files ?? [];
        if (fFiles.length > 0) {
          matched = fFiles.map((path) => ({ path }));
        }
      }

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

  private async finalizeScopeAndCommitMessage(inputData: {
    ctx: StepContext;
    loopInput: ReviewFixLoopInput;
    headBeforeFix: string;
    headAfterFix: string;
    findings: Array<{ summary: string; severity?: string; files?: string[] }>;
    reasons?: Record<string, string>;
  }): Promise<{ headAfterFix: string; changedFiles: string[]; pendingScopeWarning?: string }> {
    if (!this.deps.git) {
      return { headAfterFix: inputData.headAfterFix, changedFiles: [] };
    }

    let headAfterFix = inputData.headAfterFix;
    let pendingWarning: string | undefined;
    let normalizedChangedFiles: string[] = [];

    try {
      const changedFiles = await this.deps.git.changedFiles(
        inputData.ctx.cwd,
        inputData.headBeforeFix,
        headAfterFix,
      );

      const allowedFiles = deriveAllowedFiles(inputData.findings, inputData.ctx.cwd);
      const assessment = assessChangedFiles({
        changedFiles,
        allowedFiles,
        ...(inputData.reasons ? { reasons: inputData.reasons } : {}),
        cwd: inputData.ctx.cwd,
      });

      normalizedChangedFiles = assessment.changedFiles;

      if (assessment.outOfScopeFiles.length > 0) {
        this.emit(
          inputData.loopInput,
          'review_fix.out_of_scope_write',
          'warn',
          `out-of-scope files modified in review/fix iteration ${inputData.ctx.iterationIndex}`,
          {
            iterationIndex: inputData.ctx.iterationIndex,
            allowedFiles: assessment.allowedFiles,
            changedFiles: assessment.changedFiles,
            outOfScopeFiles: assessment.outOfScopeFiles,
          },
        );
        pendingWarning = formatScopeWarning(assessment);
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.emit(
        inputData.loopInput,
        'review_fix.scope_check_failed',
        'warn',
        `scope check failed at iteration ${inputData.ctx.iterationIndex}: ${errorMsg}`,
        {
          iterationIndex: inputData.ctx.iterationIndex,
          error: errorMsg,
        },
      );
      pendingWarning = `Warning: Scope check could not be verified for the previous fix (iteration ${inputData.ctx.iterationIndex}) due to diff inspection failure: ${errorMsg}`;
    }

    if (typeof this.deps.git.amendCommitMessage === 'function') {
      try {
        const changedFilesForMsg =
          normalizedChangedFiles.length > 0
            ? normalizedChangedFiles
            : await this.deps.git
                .changedFiles(inputData.ctx.cwd, inputData.headBeforeFix, headAfterFix)
                .catch(() => []);
        const message = buildFindingCommitMessage(inputData.findings, changedFilesForMsg);
        const replacementSha = await this.deps.git.amendCommitMessage(inputData.ctx.cwd, message);
        if (replacementSha) {
          headAfterFix = replacementSha;
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.emit(
          inputData.loopInput,
          'review_fix.commit_message_amend_failed',
          'warn',
          `commit message amendment failed at iteration ${inputData.ctx.iterationIndex}: ${errorMsg}`,
          {
            iterationIndex: inputData.ctx.iterationIndex,
            error: errorMsg,
          },
        );
      }
    } else {
      this.emit(
        inputData.loopInput,
        'review_fix.commit_message_amend_skipped',
        'info',
        `commit message amendment skipped at iteration ${inputData.ctx.iterationIndex}: git.amendCommitMessage not supported`,
        {
          iterationIndex: inputData.ctx.iterationIndex,
        },
      );
    }

    return {
      headAfterFix,
      changedFiles: normalizedChangedFiles,
      ...(pendingWarning ? { pendingScopeWarning: pendingWarning } : {}),
    };
  }

  private async checkFileOscillation(inputData: {
    ctx: StepContext;
    loopInput: ReviewFixLoopInput;
    headBeforeFix: string;
    headAfterFix: string;
    fixChangedFiles: string[];
    history: FileStateHistory;
  }): Promise<
    | {
        detected: true;
        humanReviewReason: string;
        match: FileOscillationMatch;
      }
    | { detected: false }
  > {
    if (!this.deps.git || !inputData.headBeforeFix || inputData.fixChangedFiles.length === 0) {
      return { detected: false };
    }

    const checkResult = await inspectFixCommitForOscillation({
      git: this.deps.git,
      cwd: inputData.ctx.cwd,
      headBeforeFix: inputData.headBeforeFix,
      headAfterFix: inputData.headAfterFix,
      iterationIndex: inputData.ctx.iterationIndex,
      fixChangedFiles: inputData.fixChangedFiles,
      history: inputData.history,
    });

    if (checkResult.kind === 'no_oscillation') {
      for (const skip of checkResult.skipped) {
        this.emit(
          inputData.loopInput,
          'review_fix.file_oscillation_check_skipped',
          'info',
          `file oscillation check skipped for ${skip.path} at ${skip.ref}: ${skip.error}`,
          {
            path: skip.path,
            ref: skip.ref,
            error: skip.error,
          },
        );
      }
      return { detected: false };
    }

    const match = checkResult.match;
    const humanReviewReason = formatFileOscillationReason(match, inputData.ctx.iterationIndex);

    this.emit(
      inputData.loopInput,
      'review_fix.file_oscillation_detected',
      'warn',
      humanReviewReason,
      {
        path: match.path,
        repeatedHash: match.repeatedHash,
        repeatedSha: match.repeatedSha,
        repeatedIteration: match.repeatedIteration,
        repeatedContent: match.repeatedContent,
        contestedHash: match.contestedHash,
        contestedSha: match.contestedSha,
        contestedIteration: match.contestedIteration,
        contestedContent: match.contestedContent,
      },
    );

    return {
      detected: true,
      humanReviewReason,
      match,
    };
  }

  private async loadManifest(
    input: ReviewFixLoopInput,
    ctx: { cwd: string; runId?: unknown },
  ): Promise<ManifestLoadResult> {
    return loadManifest(input, ctx, this.deps);
  }

  private async checkTaskBoundary(
    ctx: StepContext,
    loopInput: ReviewFixLoopInput,
    headBeforeFix: string,
    headAfterFix: string,
    manifestResult: ManifestLoadResult,
  ): Promise<
    { ok: true; changedFiles: string[] } | { ok: false; message: string; files?: string[] }
  > {
    if (!this.deps.git || typeof this.deps.git.changedFiles !== 'function') {
      return { ok: true, changedFiles: [] };
    }

    if (manifestResult.status === 'missing') {
      const errorMsg = 'task-manifest.json not found';
      this.emit(
        loopInput,
        'task_boundary.check_failed',
        'warn',
        `task boundary check failed: ${errorMsg}`,
        {
          iterationIndex: ctx.iterationIndex,
          reason: 'missing_manifest',
          error: errorMsg,
        },
      );
      return { ok: false, message: `task boundary check failed: ${errorMsg}` };
    }
    if (manifestResult.status === 'malformed') {
      const errorMsg = manifestResult.message;
      this.emit(
        loopInput,
        'task_boundary.check_failed',
        'warn',
        `task boundary check failed: ${errorMsg}`,
        {
          iterationIndex: ctx.iterationIndex,
          reason: 'malformed_manifest',
          error: manifestResult.error,
        },
      );
      return { ok: false, message: `task boundary check failed: ${errorMsg}` };
    }

    let committedFiles: string[];
    try {
      committedFiles = await this.deps.git.changedFiles(ctx.cwd, headBeforeFix, headAfterFix);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.emit(
        loopInput,
        'task_boundary.check_failed',
        'warn',
        `task boundary check failed: ${errorMsg}`,
        { iterationIndex: ctx.iterationIndex, reason: 'check_error', error: errorMsg },
      );
      return { ok: false, message: `task boundary check failed: ${errorMsg}` };
    }

    const classification = checkTaskBoundaries(committedFiles, manifestResult.manifest);
    const violatingFiles = [
      ...classification.modifiedReferenceFiles,
      ...classification.undeclaredFiles,
    ];
    if (violatingFiles.length > 0) {
      const message = `${loopInput.phaseId} modified undeclared files: ${violatingFiles.join(', ')}`;
      this.emit(loopInput, 'task_boundary.violated', 'warn', message, {
        phase: loopInput.phaseId,
        files: violatingFiles,
        modifiedReferenceFiles: classification.modifiedReferenceFiles,
        undeclaredFiles: classification.undeclaredFiles,
        iterationIndex: ctx.iterationIndex,
      });
      return { ok: false, message, files: violatingFiles };
    }

    return { ok: true, changedFiles: committedFiles };
  }

  private async handleBoundaryFailure(
    ctx: StepContext,
    input: ReviewFixLoopInput,
    review: Partial<ReviewStepResult>,
    fix: FixStepResult,
    boundaryCheck: { ok: false; message: string; files?: string[] },
    thisLoop: Loop,
  ): Promise<{ handled: true; loop: Loop } | { handled: false; result: ReviewFixLoopResult }> {
    let rollbackOk = true;
    if (this.deps.rollbackFix && fix.headBeforeFix) {
      rollbackOk = await this.deps.rollbackFix(ctx, fix.headBeforeFix);
    }
    if (!rollbackOk) {
      this.emit(
        input,
        'loop.rollback.failed',
        'error',
        `rollback failed on iteration ${ctx.iterationIndex}, breaking loop`,
        { index: ctx.iterationIndex },
      );
      const failedLoop = completeIteration(thisLoop, { outcome: 'failed', now: this.deps.now() });
      this.deps.loops.update(failedLoop);
      this.emitIterationCompleted(input, ctx.iterationIndex, 'failed');
      await this.appendHistoryEntry(ctx, review, fix, undefined, 'failed', input);
      await this.runCleanArtifacts(ctx);
      return {
        handled: false,
        result: {
          loop: failedLoop,
          phaseOutcome: 'failed',
          loopStatus: 'failed',
          needsHumanReview: true,
        },
      };
    }

    const updatedLoop = completeIteration(thisLoop, {
      outcome: 'unresolved',
      fixInvocationId: fix.invocationId,
      now: this.deps.now(),
    });
    this.deps.loops.update(updatedLoop);
    this.emitIterationCompleted(input, ctx.iterationIndex, 'unresolved');
    await this.appendHistoryEntry(
      ctx,
      review,
      { ...fix, detail: boundaryCheck.message },
      undefined,
      'unresolved',
      input,
    );
    await this.runCleanArtifacts(ctx);

    return { handled: true, loop: updatedLoop };
  }
}

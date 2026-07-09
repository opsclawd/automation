import {
  createLoop,
  startIteration,
  completeIteration,
  exhaust,
  updateOpenIteration,
} from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type {
  ImplementStepLoopDeps,
  ImplementStepLoopInput,
  ImplementStepLoopResult,
  QualityReviewResult,
  SpecReviewResult,
  StepLoopContext,
  TypecheckResult,
  TypescriptError,
  FixResult,
  ImplementStepHistoryEntry,
} from './types.js';
import { verifyFixCommit, type FixCommitVerification } from '../fix-commit-verifier.js';

function normalizeMessage(message: string): string {
  return message.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Decide what to pass into the implement agent's retry prompt given the raw
// typecheck output and any structured errors the parser extracted. The
// parser only handles canonical `file(line,col): error TSxxxx: ...` lines;
// standalone `error TSxxxx: ...` and wrapped build-mode lines are
// intentionally not parsed. When the raw output contains non-blank lines
// that the parser did NOT capture, fall back to the raw string so the
// implement agent sees those unparsed diagnostics too. Otherwise prefer
// the structured list for the cleaner grouped rendering.
function pickTypecheckPayload(tcResult: TypecheckResult): string | unknown[] | undefined {
  const structured = tcResult.structuredErrors;
  const raw = tcResult.output;
  if (structured !== undefined && structured.length > 0) {
    // Count non-blank, trimmed lines in raw output that the parser did not
    // absorb into structured errors. If any exist, the raw output carries
    // information the structured list would silently drop.
    const rawNonBlankLines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    // Filter out volatile TSC summary lines that are not diagnostics.
    const diagnosticLikeLines = rawNonBlankLines.filter(
      (l) =>
        !/^Found \d+ errors?\.?$/i.test(l) && !/^in \d+\.?\d*(ms|s)\s*$/i.test(l) && !/^>/.test(l), // command-echo lines like "> tsc --noEmit"
    );
    if (diagnosticLikeLines.length > structured.length && raw.length > 0) {
      return raw.slice(0, 2000);
    }
    return structured;
  }
  if (raw.length > 0) {
    return raw.slice(0, 2000);
  }
  return undefined;
}

// Shared default for `maxTypeCheckRetries` used by the programmatic API when
// the field is omitted from ImplementStepLoopInput. The config schema defaults
// to 5 when read via configuration; the programmatic fallback here is 2 to
// avoid surprising in-process callers with long retry sequences. Keep in sync
// with the documented behavior in `packages/shared/src/config/schema.ts`.
export const DEFAULT_MAX_TYPE_CHECK_RETRIES = 2;

// Stall detection horizon: keep a small history of recent fingerprints so
// cyclic regressions (A → B → A → B) don't escape detection. Tunable for tests.
const DEFAULT_STALL_HISTORY_SIZE = 2;

// Strip volatile parts of TSC/build output so unchanged errors produce the
// same fingerprint across retries. TSC output routinely contains:
//   - trailing summary lines like `Found N errors.` whose N changes
//   - working-directory prefixes from `--build` mode
//   - timestamps and timings
// We discard those and collapse whitespace.
function normalizeTypecheckOutput(output: string): string {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^Found \d+ errors?\.?$/i.test(l))
    .filter((l) => !/^in \d+\.?\d*(ms|s)\s*$/i.test(l))
    .join('\n')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export class ImplementStepLoop {
  constructor(private readonly deps: ImplementStepLoopDeps) {}

  async execute(input: ImplementStepLoopInput): Promise<ImplementStepLoopResult> {
    const { deps } = this;
    let loop = createLoop({
      id: deps.idFactory(),
      runId: input.runId,
      phaseId: input.phaseId,
      type: 'implement-step',
      maxIterations: input.maxIterations,
      now: deps.now(),
    });
    deps.loops.insert(loop);

    // --- TRAILING RE-REVIEW OPTIONS (#680) ---
    // Mirror ReviewFixLoop: merge Deps.options and Input.options, default
    // `endOnReview` to `true` so a converged final fix is confirmed rather
    // than silently discarded. Capture the original cap so the trailing
    // pass can be gated on `iterationIndex === originalMax + 1`.
    const opts = { ...(this.deps.options ?? {}), ...(input.options ?? {}) };
    const endOnReview = opts.endOnReview ?? true;
    const originalMax = loop.maxIterations;

    const canStartReviewCycle = (current: typeof loop): boolean => {
      const reviewsStarted = current.iterations.length;
      if (reviewsStarted < originalMax) return true;
      // Trailing post-fix re-review: only when the last iteration ended
      // with `fixed` (a fix commit was produced and verified).
      if (!endOnReview) return false;
      if (reviewsStarted > originalMax) return false;
      const last = current.iterations[current.iterations.length - 1];
      return last?.outcome === 'fixed';
    };

    let consecutiveFixFailures = 0;
    let lastFixInvocationId: string | undefined;
    let lastFixHeadBeforeFix: string | undefined;
    let pendingTypecheckErrors: string | TypescriptError[] | undefined;
    let contradictionRetriedThisStep = false;
    let arbiterInvokedThisStep = false;
    let pendingReconciliationContext: string | undefined;

    const baseCtx: StepLoopContext = {
      loopId: loop.id,
      runId: input.runId,
      phaseId: input.phaseId,
      repoId: input.repoId,
      cwd: input.cwd,
      stepIndex: input.stepIndex,
      stepTitle: input.stepTitle,
      iterationIndex: 1,
    };

    // --- History helpers (closure over deps/loop) ---
    const readFixerHistoryContext = async (): Promise<string | undefined> => {
      if (!deps.loopHistory) return undefined;
      try {
        const history = await deps.loopHistory.read(baseCtx);
        if (!history || history.length === 0) return undefined;
        return deps.loopHistory.format(history);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit(input, 'implement_step_history.read_failed', 'warn', msg, {
          stepIndex: input.stepIndex,
          error: msg,
        });
        return '';
      }
    };

    const appendHistory = async (entry: ImplementStepHistoryEntry): Promise<void> => {
      if (!deps.loopHistory) return;
      try {
        await deps.loopHistory.append(baseCtx, entry);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit(input, 'implement_step_history.append_failed', 'warn', msg, {
          stepIndex: input.stepIndex,
          iteration: entry.iteration,
          error: msg,
        });
      }
    };

    const buildHistoryEntry = (
      iterationIndex: number,
      specReview: SpecReviewResult,
      qualityReview: QualityReviewResult,
      fix: FixResult | undefined,
      reverted:
        | { headBeforeFix: string; typecheckOutputPreview: string; typecheckErrorCount: number }
        | undefined,
      outcome: 'resolved' | 'fixed' | 'unresolved' | 'failed',
      commitVerification?:
        | { kind: 'uncommitted_changes'; dirtyFiles: string[]; statusOutput: string }
        | { kind: 'no_commit_claimed'; statusOutput: string },
    ): ImplementStepHistoryEntry => {
      const entry: ImplementStepHistoryEntry = {
        iteration: iterationIndex,
        specReview: {
          ...(specReview.verdict !== undefined ? { verdict: specReview.verdict } : {}),
          ...(specReview.invocationId !== undefined
            ? { invocationId: specReview.invocationId }
            : {}),
        },
        qualityReview: {
          ...(qualityReview.verdict !== undefined ? { verdict: qualityReview.verdict } : {}),
          ...(qualityReview.invocationId !== undefined
            ? { invocationId: qualityReview.invocationId }
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
        ...(reverted
          ? {
              reverted: {
                typecheckOutputPreview: reverted.typecheckOutputPreview,
                typecheckErrorCount: reverted.typecheckErrorCount,
                headBeforeFix: reverted.headBeforeFix,
              },
            }
          : {}),
        ...(commitVerification && commitVerification.kind === 'uncommitted_changes'
          ? {
              uncommittedChanges: {
                dirtyFiles: commitVerification.dirtyFiles,
                statusOutput: commitVerification.statusOutput,
              },
            }
          : {}),
        ...(commitVerification && commitVerification.kind === 'no_commit_claimed'
          ? { noCommit: { statusOutput: commitVerification.statusOutput } }
          : {}),
        outcome,
      };
      return entry;
    };

    // --- PRE-LOOP: IMPLEMENT ---
    const implementResult = await deps.runImplement(baseCtx);
    if (implementResult.agentOutcome !== 'success') {
      this.emit(input, 'loop.iteration.started', 'info', 'implementation step started', {
        index: 1,
      });
      loop = startIteration(loop, {
        reviewInvocationId: '',
        now: deps.now(),
      });
      loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
      deps.loops.update(loop);
      this.emit(input, 'loop.iteration.completed', 'info', 'implement step failed', {
        index: 1,
        outcome: 'failed',
      });
      return { outcome: 'failed', loop };
    }

    // --- PRE-LOOP: TYPECHECK GATE ---
    let tcResult = await deps.runTypecheck(baseCtx);
    const maxTypeCheckRetries = input.maxTypeCheckRetries ?? DEFAULT_MAX_TYPE_CHECK_RETRIES;
    let typecheckRetryCount = 0;
    const stallHistory: string[] = [];

    while (tcResult.outcome === 'fail' && typecheckRetryCount < maxTypeCheckRetries) {
      const iterationIndex = typecheckRetryCount + 2;
      const currFingerprint = this.fingerprintTypecheck(tcResult);
      const stallHistorySize = deps.stallHistorySize ?? DEFAULT_STALL_HISTORY_SIZE;
      const stalled =
        stallHistory.length > 0 && stallHistory.slice(-stallHistorySize).includes(currFingerprint);
      if (stalled) {
        this.emit(
          input,
          'step.typecheck.stalled',
          'error',
          `step ${input.stepIndex} typecheck stalled — same errors as previous attempt; escalating`,
          {
            index: input.stepIndex,
            attempt: typecheckRetryCount,
            fingerprint: currFingerprint.slice(0, 500),
            stallHistorySize,
          },
        );
        this.emit(
          input,
          'step.typecheck.failed',
          'error',
          `step ${input.stepIndex} failed typecheck gate (stalled)`,
          { index: input.stepIndex, output: tcResult.output.slice(0, 2000), stalled: true },
        );
        this.emit(input, 'loop.iteration.started', 'info', 'typecheck stalled', {
          index: iterationIndex,
        });
        loop = startIteration(loop, { reviewInvocationId: '', now: deps.now() });
        loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(loop);
        this.emit(input, 'loop.iteration.completed', 'info', 'step stalled at typecheck gate', {
          index: iterationIndex,
          outcome: 'failed',
        });
        return { outcome: 'failed', loop };
      }
      stallHistory.push(currFingerprint);
      if (stallHistory.length > stallHistorySize) {
        stallHistory.shift();
      }

      typecheckRetryCount += 1;
      this.emit(
        input,
        'step.typecheck.retry',
        'warn',
        `step ${input.stepIndex} failed typecheck gate; retrying implement attempt ${typecheckRetryCount}/${maxTypeCheckRetries}`,
        {
          attempt: typecheckRetryCount,
          maxRetries: maxTypeCheckRetries,
          index: input.stepIndex,
          output: tcResult.output.slice(0, 2000),
        },
      );

      const retryImplementResult = await deps.runImplement(baseCtx, {
        ...(pickTypecheckPayload(tcResult) !== undefined
          ? { typecheckErrors: pickTypecheckPayload(tcResult) as string | TypescriptError[] }
          : {}),
      });

      if (retryImplementResult.agentOutcome !== 'success') {
        this.emit(input, 'loop.iteration.started', 'info', 'implementation step started', {
          index: iterationIndex,
        });
        loop = startIteration(loop, { reviewInvocationId: '', now: deps.now() });
        loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(loop);
        this.emit(input, 'loop.iteration.completed', 'info', 'implement step failed', {
          index: iterationIndex,
          outcome: 'failed',
        });
        return { outcome: 'failed', loop };
      }

      tcResult = await deps.runTypecheck(baseCtx);
    }

    if (tcResult.outcome === 'fail') {
      this.emit(
        input,
        'step.typecheck.failed',
        'error',
        `step ${input.stepIndex} failed typecheck gate`,
        { index: input.stepIndex, output: tcResult.output.slice(0, 2000) },
      );
      const finalIterationIndex = typecheckRetryCount + 1;
      this.emit(input, 'loop.iteration.started', 'info', 'typecheck gate failed', {
        index: finalIterationIndex,
      });
      loop = startIteration(loop, { reviewInvocationId: '', now: deps.now() });
      loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
      deps.loops.update(loop);
      this.emit(input, 'loop.iteration.completed', 'info', 'step failed typecheck gate', {
        index: finalIterationIndex,
        outcome: 'failed',
      });
      return { outcome: 'failed', loop };
    }

    // Enter review-fix loop
    while (canStartReviewCycle(loop)) {
      const iterationIndex = loop.iterations.length + 1;
      const isTrailingReview = iterationIndex === originalMax + 1;
      const ctx: StepLoopContext = { ...baseCtx, iterationIndex };

      // --- TRAILING RE-REVIEW STARTED (#680) ---
      if (isTrailingReview) {
        // Mirror ReviewFixLoop: bump `loop.maxIterations` so the trailing
        // pass is admitted by the underlying iteration machinery.
        if (loop.iterations.length === originalMax) {
          loop = { ...loop, maxIterations: loop.iterations.length + 1 };
        }
        this.emit(
          input,
          'loop.trailing_review.started',
          'info',
          `trailing re-review at iteration ${iterationIndex} after cap iteration ended fixed`,
          { iteration: iterationIndex, originalMax, lastOutcome: 'fixed' },
        );
      }

      // --- TOP-OF-ITERATION TYPECHECK + OPTIONAL REVERT (#671) ---
      if (iterationIndex > 1) {
        tcResult = await deps.runTypecheck(baseCtx);
        if (tcResult.outcome === 'fail') {
          // Try to revert the build-breaking fix if a previous fix exists with
          // a known-passing headBeforeFix captured.
          // On the trailing re-review pass, never invoke revertFix — it
          // would destroy the just-confirmed fix. Escalate to
          // `needs_human_review` instead (#680).
          if (
            !isTrailingReview &&
            lastFixHeadBeforeFix !== undefined &&
            deps.revertFix !== undefined
          ) {
            const reverted = await deps.revertFix(ctx, lastFixHeadBeforeFix);
            if (reverted) {
              this.emit(
                input,
                'step.typecheck.reverted',
                'warn',
                `step ${input.stepIndex} build-breaking fix reverted at iteration ${iterationIndex}`,
                {
                  index: input.stepIndex,
                  iteration: iterationIndex,
                  restoredSha: lastFixHeadBeforeFix,
                  typecheckOutput: tcResult.output.slice(0, 2000),
                },
              );
              // Capture the typecheck payload to feed the next fixer call.
              pendingTypecheckErrors = pickTypecheckPayload(tcResult) as
                | string
                | TypescriptError[]
                | undefined;
              // Count fix as a failure even when agent reported `done_with_fixes`.
              consecutiveFixFailures += 1;
              loop = startIteration(loop, { reviewInvocationId: '', now: deps.now() });
              // Append a history entry recording the revert (no reviews ran
              // this loop pass — typecheck failed before review stage).
              await appendHistory(
                buildHistoryEntry(
                  iterationIndex,
                  { invocationId: '', agentOutcome: 'success' },
                  { invocationId: '', agentOutcome: 'success' },
                  undefined,
                  {
                    headBeforeFix: lastFixHeadBeforeFix,
                    typecheckOutputPreview: tcResult.output.slice(0, 1000),
                    typecheckErrorCount: tcResult.structuredErrors?.length ?? 0,
                  },
                  'unresolved',
                ),
              );
              loop = completeIteration(loop, { outcome: 'unresolved', now: deps.now() });
              deps.loops.update(loop);
              this.emitIterationCompleted(input, iterationIndex, 'unresolved');
              // Drop the head-before-fix so the next pass does not try to revert again.
              lastFixHeadBeforeFix = undefined;
              continue;
            }
            // revertFix returned false — fall through to the human-review
            // branch below.
          }

          // No revertFix wired, or revert itself failed.
          this.emit(
            input,
            'step.typecheck.failed',
            'error',
            `step ${input.stepIndex} iteration ${iterationIndex} typecheck failed after fix; cannot auto-revert`,
            {
              index: input.stepIndex,
              iteration: iterationIndex,
              output: tcResult.output.slice(0, 2000),
            },
          );
          this.emit(
            input,
            'loop.iteration.started',
            'info',
            `iteration ${iterationIndex} started`,
            {
              index: iterationIndex,
            },
          );
          loop = startIteration(loop, { reviewInvocationId: '', now: deps.now() });
          // Append a history entry without a `reverted` block (no revert succeeded).
          await appendHistory(
            buildHistoryEntry(
              iterationIndex,
              { invocationId: '', agentOutcome: 'success' },
              { invocationId: '', agentOutcome: 'success' },
              undefined,
              undefined,
              'failed',
            ),
          );
          loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
          deps.loops.update(loop);
          this.emitIterationCompleted(input, iterationIndex, 'failed');
          return { outcome: 'needs_human_review', loop };
        } else if (loop.iterations[iterationIndex - 2]?.outcome === 'fixed') {
          consecutiveFixFailures = 0;
        }
      }

      this.emit(input, 'loop.iteration.started', 'info', `iteration ${iterationIndex} started`, {
        index: iterationIndex,
      });

      // --- SPEC-REVIEW ---
      const MAX_SPEC_REVIEW_ATTEMPTS = 3;
      let specReview: SpecReviewResult;
      let specReviewAttempts = 0;
      const specReviewAttemptInvocationIds: string[] = [];
      do {
        specReviewAttempts += 1;
        specReview = await deps.runSpecReview(ctx, tcResult);
        specReviewAttemptInvocationIds.push(specReview.invocationId);
        if (specReview.agentOutcome === 'success' && specReview.verdict !== undefined) {
          break;
        }
        if (specReviewAttempts < MAX_SPEC_REVIEW_ATTEMPTS) {
          this.emit(
            input,
            'step.spec-review.retry',
            'warn',
            `spec-review attempt ${specReviewAttempts} failed (invocation ${specReview.invocationId}), retrying...`,
            {
              attempt: specReviewAttempts,
              maxAttempts: MAX_SPEC_REVIEW_ATTEMPTS,
              agentOutcome: specReview.agentOutcome,
              hasVerdict: specReview.verdict !== undefined,
              invocationId: specReview.invocationId,
            },
          );
        }
      } while (specReviewAttempts < MAX_SPEC_REVIEW_ATTEMPTS);

      this.emit(
        input,
        'step.spec-review.attempts',
        'info',
        `spec-review completed after ${specReviewAttempts} attempt(s)`,
        {
          index: iterationIndex,
          attempts: specReviewAttempts,
          invocationIds: specReviewAttemptInvocationIds,
        },
      );

      loop = startIteration(loop, {
        reviewInvocationId: specReview.invocationId,
        now: deps.now(),
      });

      if (specReview.agentOutcome !== 'success' || specReview.verdict === undefined) {
        loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'failed');
        return { outcome: 'failed', loop };
      }
      deps.loops.update(loop);

      // --- QUALITY-REVIEW ---
      const qualityReview = await deps.runQualityReview(ctx, tcResult);
      loop = updateOpenIteration(loop, { qualityReviewInvocationId: qualityReview.invocationId });
      deps.loops.update(loop);
      if (qualityReview.agentOutcome !== 'success' || qualityReview.verdict === undefined) {
        loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'failed');
        return { outcome: 'failed', loop };
      }

      if (specReview.verdict === 'pass' && qualityReview.verdict === 'pass') {
        loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
        deps.loops.update(loop);
        await appendHistory(
          buildHistoryEntry(
            iterationIndex,
            specReview,
            qualityReview,
            undefined,
            undefined,
            'resolved',
          ),
        );
        this.emitIterationCompleted(input, iterationIndex, 'resolved');
        return { outcome: 'success', loop };
      }

      // --- FALLBACK ESCALATION ---
      const escalateForFixFailures = consecutiveFixFailures >= 2;
      const useFallback = escalateForFixFailures && deps.fixFallbackProfile !== undefined;
      if (useFallback) {
        this.emitEscalation(input, 'two_consecutive_fix_failures');
      }

      // --- TRAILING RE-REVIEW SHORT-CIRCUIT (#680) ---
      // Reviews already ran above (the trailing pass skips `runFix`). If
      // either review failed, the existing branch at line ~533 already
      // fell through to the `runFix` invocation; intercept that here and
      // record the trailing pass as `unresolved` then exit the loop.
      if (isTrailingReview) {
        loop = completeIteration(loop, { outcome: 'unresolved', now: deps.now() });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'unresolved');
        break;
      }

      // --- FIX ---
      const historyContext = await readFixerHistoryContext();
      const fix = await deps.runFix(ctx, {
        useFallback,
        ...(historyContext !== undefined ? { historyContext } : {}),
        ...(pendingReconciliationContext !== undefined
          ? { reconciliationContext: pendingReconciliationContext }
          : {}),
        ...(pendingTypecheckErrors !== undefined
          ? { typecheckErrors: pendingTypecheckErrors }
          : {}),
        ...(useFallback && lastFixInvocationId !== undefined
          ? { previousInvocationId: lastFixInvocationId }
          : {}),
      });
      pendingReconciliationContext = undefined;
      pendingTypecheckErrors = undefined;
      lastFixInvocationId = fix.invocationId;
      lastFixHeadBeforeFix = fix.headBeforeFix;

      if (
        fix.agentOutcome !== 'success' ||
        fix.verdict === undefined ||
        fix.verdict === 'cannot_fix'
      ) {
        consecutiveFixFailures += 1;
        loop = completeIteration(loop, {
          outcome: 'unresolved',
          fixInvocationId: fix.invocationId,
          now: deps.now(),
        });
        deps.loops.update(loop);
        await appendHistory(
          buildHistoryEntry(
            iterationIndex,
            specReview,
            qualityReview,
            fix,
            undefined,
            'unresolved',
          ),
        );
        this.emitIterationCompleted(input, iterationIndex, 'unresolved');
        continue;
      }

      // --- CONTRADICTION DETECTION (unchanged) ---
      const reviewFailed = specReview.verdict === 'fail' || qualityReview.verdict === 'fail';
      if (fix.verdict === 'done_no_fixes_needed' && reviewFailed) {
        this.emit(
          input,
          'review.contradiction.detected',
          'warn',
          `review/fix contradiction at iteration ${iterationIndex}: fixer disagrees with failing review`,
          {
            iterationIndex,
            specVerdict: specReview.verdict,
            qualityVerdict: qualityReview.verdict,
            hasRebuttal: Boolean(fix.rebuttal),
          },
        );

        if (!contradictionRetriedThisStep) {
          // --- 1-SHOT RECONCILIATION RE-RUN (#45 port) ---
          contradictionRetriedThisStep = true;
          const rerunSpec =
            specReview.verdict === 'fail' ? await deps.runSpecReview(ctx, tcResult) : specReview;
          const rerunQuality =
            qualityReview.verdict === 'fail'
              ? await deps.runQualityReview(ctx, tcResult)
              : qualityReview;
          const rerunSpecOk = rerunSpec.agentOutcome === 'success' && rerunSpec.verdict === 'pass';
          const rerunQualityOk =
            rerunQuality.agentOutcome === 'success' && rerunQuality.verdict === 'pass';
          if (rerunSpecOk && rerunQualityOk) {
            // Contradiction resolved by re-run
            loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
            deps.loops.update(loop);
            await appendHistory(
              buildHistoryEntry(
                iterationIndex,
                rerunSpec,
                rerunQuality,
                fix,
                undefined,
                'resolved',
              ),
            );
            this.emitIterationCompleted(input, iterationIndex, 'resolved');
            return { outcome: 'success', loop };
          }
        }

        // --- ARBITER ESCALATION ---
        if (!arbiterInvokedThisStep && deps.runArbiter !== undefined) {
          arbiterInvokedThisStep = true;
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
          const arbiterResult = await deps.runArbiter(ctx, tcResult, fix);
          if (!arbiterResult.evidence || arbiterResult.evidence.trim().length === 0) {
            this.emit(
              input,
              'needs_human_review',
              'warn',
              `arbiter returned empty evidence at iteration ${iterationIndex} — escalating to human`,
              { iterationIndex, outcome: arbiterResult.outcome },
            );
            loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
            deps.loops.update(loop);
            return { outcome: 'needs_human_review', loop };
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
            loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
            deps.loops.update(loop);
            await appendHistory(
              buildHistoryEntry(
                iterationIndex,
                specReview,
                qualityReview,
                fix,
                undefined,
                'resolved',
              ),
            );
            this.emitIterationCompleted(input, iterationIndex, 'resolved');
            return { outcome: 'success', loop };
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
            loop = completeIteration(loop, {
              outcome: 'unresolved',
              fixInvocationId: fix.invocationId,
              now: deps.now(),
            });
            deps.loops.update(loop);
            await appendHistory(
              buildHistoryEntry(
                iterationIndex,
                specReview,
                qualityReview,
                fix,
                undefined,
                'unresolved',
              ),
            );
            this.emitIterationCompleted(input, iterationIndex, 'unresolved');
            consecutiveFixFailures = 0;
            continue;
          }
          this.emit(
            input,
            'needs_human_review',
            'warn',
            `arbiter could not resolve contradiction at iteration ${iterationIndex}: ${arbiterResult.outcome}`,
            { ruling: arbiterResult.outcome, evidence: arbiterResult.evidence, iterationIndex },
          );
          loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
          deps.loops.update(loop);
          return { outcome: 'needs_human_review', loop };
        }

        this.emit(
          input,
          'needs_human_review',
          'warn',
          arbiterInvokedThisStep
            ? `second contradiction after arbiter at iteration ${iterationIndex} — escalating to human`
            : `contradiction after 1-shot re-run with no arbiter configured at iteration ${iterationIndex}`,
          { iterationIndex, arbiterInvokedThisStep },
        );
        loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(loop);
        return { outcome: 'needs_human_review', loop };
      }

      if (fix.verdict === 'done_with_fixes' && fix.headBeforeFix !== undefined && deps.git) {
        const verification: FixCommitVerification | { kind: 'verification_error'; error: string } =
          await verifyFixCommit({
            git: deps.git,
            cwd: ctx.cwd,
            expectedHead: fix.headBeforeFix,
          });
        if (verification.kind === 'uncommitted_changes') {
          this.emit(
            input,
            'fix.uncommitted_changes',
            'warn',
            `step ${input.stepIndex} iteration ${iterationIndex} fix claimed done_with_fixes but HEAD did not advance and worktree has ${verification.dirtyFiles.length} dirty file(s)`,
            {
              stepIndex: input.stepIndex,
              iterationIndex,
              invocationId: fix.invocationId,
              expectedHead: fix.headBeforeFix,
              actualHead: verification.headAfterFix,
              dirtyFiles: verification.dirtyFiles.slice(0, 200),
              statusOutput: verification.statusOutput.slice(0, 4000),
            },
          );
          consecutiveFixFailures += 1;
          loop = completeIteration(loop, {
            outcome: 'unresolved',
            fixInvocationId: fix.invocationId,
            now: deps.now(),
          });
          deps.loops.update(loop);
          await appendHistory(
            buildHistoryEntry(
              iterationIndex,
              specReview,
              qualityReview,
              fix,
              undefined,
              'unresolved',
              verification,
            ),
          );
          // Do NOT call deps.revertFix here (plan-review P0, #679): this
          // branch means the fixer left uncommitted changes in the tree
          // (e.g. a pre-commit hook rejected the commit). That dirty state
          // is exactly what the NEXT fixer iteration needs to see in order
          // to finish committing or fixing it — reverting here would
          // destroy the evidence #679 exists to preserve. Reverting is only
          // correct for the separate build-breaking-fix case (#671), which
          // has its own dedicated branch elsewhere in this loop.
          // Clear lastFixHeadBeforeFix so the next iteration's build-breaking
          // typecheck path does NOT revert to the pre-fix SHA and destroy the
          // dirty fix attempts (#679 review feedback).
          lastFixHeadBeforeFix = undefined;
          this.emitIterationCompleted(input, iterationIndex, 'unresolved');
          continue;
        }
        if (verification.kind === 'no_commit_claimed') {
          this.emit(
            input,
            'fix.no_commit_claimed',
            'warn',
            `step ${input.stepIndex} iteration ${iterationIndex} fix claimed done_with_fixes but HEAD did not advance and worktree is clean`,
            {
              stepIndex: input.stepIndex,
              iterationIndex,
              invocationId: fix.invocationId,
              expectedHead: fix.headBeforeFix,
              actualHead: verification.headAfterFix,
            },
          );
          consecutiveFixFailures += 1;
          loop = completeIteration(loop, {
            outcome: 'unresolved',
            fixInvocationId: fix.invocationId,
            now: deps.now(),
          });
          deps.loops.update(loop);
          await appendHistory(
            buildHistoryEntry(
              iterationIndex,
              specReview,
              qualityReview,
              fix,
              undefined,
              'unresolved',
              verification,
            ),
          );
          // Same rationale as uncommitted_changes: do not let the next
          // iteration's build-breaking rollback destroy the fixer's output.
          lastFixHeadBeforeFix = undefined;
          this.emitIterationCompleted(input, iterationIndex, 'unresolved');
          continue;
        }
        if (verification.kind === 'verification_error') {
          this.emit(
            input,
            'fix.verification_error',
            'warn',
            `step ${input.stepIndex} iteration ${iterationIndex} could not verify fix commit: ${verification.error}`,
            {
              stepIndex: input.stepIndex,
              iterationIndex,
              invocationId: fix.invocationId,
              error: verification.error,
            },
          );
          // Fall through to normal success path — verifier could not read the tree.
        }
      }

      loop = completeIteration(loop, {
        outcome: 'fixed',
        fixInvocationId: fix.invocationId,
        now: deps.now(),
      });
      deps.loops.update(loop);
      await appendHistory(
        buildHistoryEntry(iterationIndex, specReview, qualityReview, fix, undefined, 'fixed'),
      );
      this.emitIterationCompleted(input, iterationIndex, 'fixed');
    }

    // If the trailing re-review ran, `loop.maxIterations` already reflects
    // `originalMax + 1` (mirrors `ReviewFixLoop.canStartReviewCycle`).
    // Otherwise, `loop.maxIterations` still equals `originalMax`. The
    // `exhaust` and `loop.exhausted` event both report the actual values
    // verbatim, so operators can detect the trailing pass by comparing
    // `maxIterations` to their input.
    loop = exhaust(loop, deps.now());
    deps.loops.update(loop);
    this.emit(
      input,
      'loop.exhausted',
      'error',
      `implement-step loop exhausted after ${loop.iterations.length} iterations`,
      {
        iterations: loop.iterations.length,
        maxIterations: loop.maxIterations,
      },
    );
    return { outcome: 'failed', loop };
  }

  private emit(
    input: ImplementStepLoopInput,
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

  private emitIterationCompleted(
    input: ImplementStepLoopInput,
    index: number,
    outcome: string,
  ): void {
    this.emit(
      input,
      'loop.iteration.completed',
      'info',
      `iteration ${index} completed: ${outcome}`,
      { index, outcome },
    );
  }

  private emitEscalation(input: ImplementStepLoopInput, triggerReason: string): void {
    const { deps } = this;
    const toProfile = deps.fixFallbackProfile!;
    this.emit(input, 'phase.fallback.escalated', 'warn', `escalating fix to ${toProfile}`, {
      fromProfile: deps.fixProfile as unknown as string,
      toProfile: toProfile as unknown as string,
      triggerReason,
      triggerOwner: 'use_case',
    });
  }

  private fingerprintTypecheck(tcResult: TypecheckResult): string {
    const errors = tcResult.structuredErrors;
    if (errors !== undefined && errors.length > 0) {
      return [...errors]
        .sort((a, b) =>
          `${a.file}:${a.line}:${a.col}:${a.code}`.localeCompare(
            `${b.file}:${b.line}:${b.col}:${b.code}`,
          ),
        )
        .map((e) => `${e.file}:${e.line}:${e.col}:${e.code}:${normalizeMessage(e.message)}`)
        .join('\n');
    }
    // Fallback when structured errors aren't available: normalize the raw
    // output to strip volatile parts (Found N errors, timings, etc.) so an
    // unchanged error set produces the same fingerprint across retries.
    // Without this, TSC's per-run noise (line numbers, error counts, summary
    // lines) defeats stall detection entirely.
    return normalizeTypecheckOutput(tcResult.output);
  }
}

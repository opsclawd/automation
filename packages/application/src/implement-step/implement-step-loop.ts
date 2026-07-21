import {
  createLoop,
  startIteration,
  completeIteration as domainCompleteIteration,
  exhaust,
  updateOpenIteration,
  AgentProfileName,
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
  ArbiterResult,
  ImplementResult,
  ImplementStepOptions,
  HolisticFile,
  HolisticFinding,
  ReviewMode,
  DimensionName,
  DimensionState,
  ReviewScopeOptions,
} from './types.js';
import type { ReviewAttempt, ReviewDimensionState, ReviewSnapshot } from '../review-state/types.js';
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

/**
 * Returns the declared files for a task entry (V2 expected_files merged with
 * V1 files for backwards compatibility). Normalizes slashes without filesystem
 * access.
 */
function getDeclaredFiles(task: {
  expected_files?: string[] | null | undefined;
  files?: string[] | null | undefined;
}): string[] {
  return [...(task.expected_files ?? []), ...(task.files ?? [])].map((f) => f.replace(/\\/g, '/'));
}

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

interface GitStateSnapshot {
  head: string;
  status: string;
}

async function captureGitState(
  git: ImplementStepLoopDeps['git'],
  cwd: string,
): Promise<GitStateSnapshot | undefined> {
  if (!git) return undefined;
  try {
    const [head, status] = await Promise.all([git.headCommitSha(cwd), git.status(cwd)]);
    return { head, status };
  } catch {
    return undefined;
  }
}

function getDirtyDimensions(
  dirtyDimensions: Record<DimensionName, DimensionState>,
): DimensionName[] {
  return (Object.entries(dirtyDimensions) as [DimensionName, DimensionState][])
    .filter(([, state]) => state === 'dirty' || state === 'recurred')
    .map(([dim]) => dim);
}

function areAllDimensionsClean(dirtyDimensions: Record<DimensionName, DimensionState>): boolean {
  return Object.values(dirtyDimensions).every((state) => state === 'clean');
}

function markDimensionDirty(
  dirtyDimensions: Record<DimensionName, DimensionState>,
  dimension: DimensionName,
  newState: DimensionState = 'dirty',
): Record<DimensionName, DimensionState> {
  return { ...dirtyDimensions, [dimension]: newState };
}

function markDimensionClean(
  dirtyDimensions: Record<DimensionName, DimensionState>,
  dimension: DimensionName,
): Record<DimensionName, DimensionState> {
  return { ...dirtyDimensions, [dimension]: 'clean' };
}

function getReviewMode(
  iterationIndex: number,
  isInFinalPair: boolean,
  deltaScopedReReview: boolean,
): ReviewMode {
  if (isInFinalPair) return 'final_full';
  if (iterationIndex === 1) return 'initial_full';
  return deltaScopedReReview ? 'intermediate_delta' : 'initial_full';
}

function buildReviewSnapshot(identity: string): ReviewSnapshot {
  return { kind: 'git', identity, capturedAt: new Date().toISOString() };
}

function buildReviewAttempt(params: {
  attemptId: string;
  runId: string;
  reviewMode: ReviewMode;
  dimension: DimensionName;
  step: string;
  snapshot?: { snapshot: string };
  verdict?: string;
  now: () => Date;
}): ReviewAttempt {
  const { attemptId, runId, reviewMode, dimension, step, snapshot, verdict, now } = params;
  const result: ReviewAttempt = {
    attemptId,
    runId,
    scope: 'implement',
    step,
    reviewMode,
    dimension,
    createdAt: now().toISOString(),
    artifacts: [],
  };
  if (snapshot) {
    result.snapshot = buildReviewSnapshot(snapshot.snapshot);
  }
  if (verdict) {
    result.verdict = verdict;
  }
  return result;
}

function buildDimensionState(params: {
  dimension: DimensionName;
  snapshot?: { snapshot: string };
  verdict?: string;
  state: DimensionState;
}): ReviewDimensionState {
  const { dimension, snapshot, verdict, state } = params;
  const result: ReviewDimensionState = {
    dimension,
    dirty: state === 'dirty' || state === 'recurred',
    provisionallyClean: state === 'clean',
    unresolvedRecords: [],
    dispositionHistory: [],
  };
  if (snapshot) {
    result.latestSnapshot = buildReviewSnapshot(snapshot.snapshot);
  }
  if (verdict) {
    result.latestVerdict = verdict;
  }
  return result;
}

export class ImplementStepLoop {
  constructor(private readonly deps: ImplementStepLoopDeps) {}

  async execute(input: ImplementStepLoopInput): Promise<ImplementStepLoopResult> {
    const { deps } = this;
    let bonusIterationUsed = false;
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
      if (reviewsStarted < originalMax + (bonusIterationUsed ? 1 : 0)) return true;
      // Trailing post-fix re-review: only when the last iteration ended
      // with `fixed` (a fix commit was produced and verified).
      if (!endOnReview) return false;
      if (reviewsStarted > originalMax + (bonusIterationUsed ? 1 : 0)) return false;
      const last = current.iterations[current.iterations.length - 1];
      return last?.outcome === 'fixed';
    };

    const PRODUCTIVE_CHURN_THRESHOLD = 3;
    let consecutiveFixedWithoutResolution = 0;
    let emittedProductiveChurnEscalation = false;
    let emittedProductiveChurnDiagnostic = false;

    const completeIteration = (
      currentLoop: typeof loop,
      options: {
        outcome: 'resolved' | 'fixed' | 'unresolved' | 'failed';
        fixInvocationId?: string;
        now: Date;
      },
    ): typeof loop => {
      const outcome = options.outcome;
      if (outcome === 'unresolved' || outcome === 'failed') {
        consecutiveFixedWithoutResolution = 0;
        emittedProductiveChurnEscalation = false;
        emittedProductiveChurnDiagnostic = false;
      } else if (outcome === 'fixed') {
        consecutiveFixedWithoutResolution += 1;
      }
      return domainCompleteIteration(currentLoop, options);
    };

    let consecutiveFixFailures = 0;
    let lastFixInvocationId: string | undefined;
    let lastFixHeadBeforeFix: string | undefined;
    let pendingTypecheckErrors: string | TypescriptError[] | undefined;
    let contradictionRetriedThisStep = false;
    let arbiterInvokedThisStep = false;
    let pendingReconciliationContext: string | undefined;

    // --- DIMENSION STATE TRACKING (#723) ---
    // Initialize dirty dimensions: both start dirty for initial_full pass
    let dirtyDimensions: Record<DimensionName, DimensionState> = {
      spec: 'dirty',
      quality: 'dirty',
    };
    let isInFinalPair = false;
    let finalPairCandidateHead: string | undefined;
    let finalPairSpecSnapshot: string | undefined;
    let finalPairQualitySnapshot: string | undefined;

    // Initialize or use provided reviewState
    if (deps.reviewState) {
      dirtyDimensions = { ...deps.reviewState.dirtyDimensions };
      finalPairCandidateHead = deps.reviewState.finalPairCandidateHead;
      finalPairSpecSnapshot = deps.reviewState.finalPairSnapshots.spec;
      finalPairQualitySnapshot = deps.reviewState.finalPairSnapshots.quality;
    }

    // Persist review state helper
    const persistReviewState = (): void => {
      if (deps.reviewState) {
        deps.reviewState.dirtyDimensions = { ...dirtyDimensions };
        deps.reviewState.finalPairCandidateHead = finalPairCandidateHead;
        deps.reviewState.finalPairSnapshots = {
          spec: finalPairSpecSnapshot,
          quality: finalPairQualitySnapshot,
        };
      }
    };

    const baseCtx: StepLoopContext = {
      loopId: loop.id,
      runId: input.runId,
      phaseId: input.phaseId,
      repoId: input.repoId,
      cwd: input.cwd,
      stepIndex: input.stepIndex,
      stepTitle: input.stepTitle,
      iterationIndex: 1,
      manifest: input.manifest,
      planMd: input.planMd,
    };

    // --- History helpers (closure over deps/loop) ---
    const readFixerHistory = async (): Promise<ImplementStepHistoryEntry[] | undefined> => {
      if (!deps.loopHistory) return undefined;
      try {
        const history = await deps.loopHistory.read(baseCtx);
        if (!history || history.length === 0) return undefined;
        return history;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit(input, 'implement_step_history.read_failed', 'warn', msg, {
          stepIndex: input.stepIndex,
          error: msg,
        });
        return undefined;
      }
    };

    const formatFixerHistory = (history: ImplementStepHistoryEntry[]): string | undefined => {
      if (!deps.loopHistory || !history || history.length === 0) return undefined;
      return deps.loopHistory.format(history);
    };

    const detectHolisticFiles = (
      history: ImplementStepHistoryEntry[],
      currentFindings: Array<{
        severity: string;
        summary: string;
        file?: string;
        suggested_fix?: string;
      }>,
      iterationIndex: number,
      thresholdIteration: number,
      thresholdFindings: number,
    ): HolisticFile[] | undefined => {
      if (iterationIndex < thresholdIteration) return undefined;

      const findingsByFile = new Map<string, HolisticFinding[]>();

      for (const entry of history) {
        const allFindings = [
          ...(entry.specReview.findings ?? []),
          ...(entry.qualityReview.findings ?? []),
        ];

        for (const f of allFindings) {
          if (!f.file) continue;
          const list = findingsByFile.get(f.file) ?? [];
          list.push({
            severity: f.severity,
            summary: f.summary,
            ...(f.suggested_fix !== undefined ? { suggested_fix: f.suggested_fix } : {}),
            iteration: entry.iteration,
            // For holistic re-derivation, findings from prior iterations are
            // treated as 'resolved' constraints that must remain satisfied.
            status: 'resolved',
          });
          findingsByFile.set(f.file, list);
        }
      }

      const holisticFiles: HolisticFile[] = [];
      for (const [file, priorFindings] of findingsByFile.entries()) {
        if (priorFindings.length >= thresholdFindings) {
          // Threshold met for this file based on prior history. Include both
          // historical (resolved) and current (open) findings for the file.
          const currentForFile = currentFindings.filter((f) => f.file === file);
          const allForFile = [
            ...priorFindings,
            ...currentForFile.map((f) => ({
              severity: f.severity,
              summary: f.summary,
              ...(f.suggested_fix !== undefined ? { suggested_fix: f.suggested_fix } : {}),
              iteration: iterationIndex,
              status: 'open' as const,
            })),
          ];
          holisticFiles.push({ file, findings: allForFile });
        }
      }

      return holisticFiles.length > 0 ? holisticFiles : undefined;
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
      arbiter?: ArbiterResult,
    ): ImplementStepHistoryEntry => {
      const entry: ImplementStepHistoryEntry = {
        iteration: iterationIndex,
        specReview: {
          ...(specReview.verdict !== undefined ? { verdict: specReview.verdict } : {}),
          ...(specReview.invocationId !== undefined
            ? { invocationId: specReview.invocationId }
            : {}),
          ...(specReview.findings !== undefined ? { findings: specReview.findings } : {}),
        },
        qualityReview: {
          ...(qualityReview.verdict !== undefined ? { verdict: qualityReview.verdict } : {}),
          ...(qualityReview.invocationId !== undefined
            ? { invocationId: qualityReview.invocationId }
            : {}),
          ...(qualityReview.findings !== undefined ? { findings: qualityReview.findings } : {}),
        },
        ...(fix
          ? {
              fix: {
                ...(fix.verdict !== undefined ? { verdict: fix.verdict } : {}),
                ...(fix.invocationId !== undefined ? { invocationId: fix.invocationId } : {}),
                ...(fix.headBeforeFix !== undefined ? { headBeforeFix: fix.headBeforeFix } : {}),
                ...(fix.summary !== undefined ? { summary: fix.summary } : {}),
                ...(fix.rebuttal !== undefined ? { rebuttal: fix.rebuttal } : {}),
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
        ...(arbiter
          ? {
              arbiter: {
                outcome: arbiter.outcome,
                evidence: arbiter.evidence,
                rationale: arbiter.rationale,
              },
            }
          : {}),
        outcome,
      };
      return entry;
    };

    // --- PRE-LOOP: IMPLEMENT ---
    const implementResult = await this.runImplementWithFallback(input, {
      ...baseCtx,
      metadata: {
        implementation_task_number: input.stepIndex,
        iteration: 1,
        invocation_type: 'initial',
      },
    });
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
    let retryProducedNoChanges = false;
    const stallHistory: string[] = [];
    const scopeSet: Set<string> = new Set();
    const taskEntry = input.manifest?.tasks?.[input.stepIndex - 1];
    const declaredFiles = taskEntry ? getDeclaredFiles(taskEntry) : [];

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
            retryProducedNoChanges: false,
          },
        );
        this.emit(
          input,
          'step.typecheck.failed',
          'error',
          `step ${input.stepIndex} failed typecheck gate (stalled)`,
          {
            index: input.stepIndex,
            output: tcResult.output.slice(0, 2000),
            stalled: true,
            retryProducedNoChanges: false,
          },
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

      const implicatedFiles = tcResult.implicatedFiles ?? [];
      const outOfScopeFiles = implicatedFiles.filter(
        (f: string) => !declaredFiles.includes(f.replace(/\\/g, '/')),
      );
      const newFiles: string[] = [];
      for (const file of outOfScopeFiles) {
        const normalized = file.replace(/\\/g, '/');
        if (!scopeSet.has(normalized)) {
          scopeSet.add(normalized);
          newFiles.push(normalized);
        }
      }
      if (newFiles.length > 0) {
        const sortedScope = [...scopeSet].sort();
        this.emit(
          input,
          'step.typecheck.scope_widened',
          'warn',
          `step ${input.stepIndex} typecheck retry ${typecheckRetryCount} widened scope by ${newFiles.length} trusted file(s)`,
          {
            index: input.stepIndex,
            attempt: typecheckRetryCount,
            newlyAddedFiles: newFiles.sort(),
            accumulatedScope: sortedScope,
            implicatedFiles,
            errorCodes: (tcResult.structuredErrors ?? [])
              .map((e: TypescriptError) => e.code)
              .sort(),
          },
        );
      }

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

      const gitStateBefore = await captureGitState(deps.git, baseCtx.cwd);

      const retryImplementResult = await this.runImplementWithFallback(
        input,
        {
          ...baseCtx,
          metadata: {
            implementation_task_number: input.stepIndex,
            iteration: iterationIndex,
            invocation_type: 'retry',
          },
        },
        {
          ...(pickTypecheckPayload(tcResult) !== undefined
            ? { typecheckErrors: pickTypecheckPayload(tcResult) as string | TypescriptError[] }
            : {}),
          ...(scopeSet.size > 0 ? { additionalEditableFiles: [...scopeSet].sort() } : {}),
        },
      );

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

      const gitStateAfter = await captureGitState(deps.git, baseCtx.cwd);
      const retryProducedNoChangesThisAttempt =
        gitStateBefore !== undefined &&
        gitStateAfter !== undefined &&
        gitStateBefore.head === gitStateAfter.head &&
        gitStateBefore.status === gitStateAfter.status;

      if (retryProducedNoChangesThisAttempt) {
        retryProducedNoChanges = true;
        this.emit(
          input,
          'step.typecheck.retry_no_op',
          'error',
          `step ${input.stepIndex} typecheck retry ${typecheckRetryCount} produced no changes`,
          {
            index: input.stepIndex,
            attempt: typecheckRetryCount,
            invocationId: retryImplementResult.invocationId,
            transcriptExcerpt: retryImplementResult.transcriptExcerpt?.slice(0, 2000) ?? '',
            retryProducedNoChanges: true,
          },
        );
        break;
      }

      tcResult = await deps.runTypecheck(baseCtx);
    }

    if (tcResult.outcome === 'fail') {
      if (retryProducedNoChanges) {
        this.emit(
          input,
          'step.typecheck.stalled',
          'error',
          `step ${input.stepIndex} typecheck retry produced no changes`,
          {
            index: input.stepIndex,
            attempt: typecheckRetryCount,
            fingerprint: this.fingerprintTypecheck(tcResult).slice(0, 500),
            retryProducedNoChanges: true,
          },
        );
      }
      this.emit(
        input,
        'step.typecheck.failed',
        'error',
        `step ${input.stepIndex} failed typecheck gate`,
        { index: input.stepIndex, output: tcResult.output.slice(0, 2000), retryProducedNoChanges },
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
      const isTrailingReview = iterationIndex > originalMax;
      const startedInFinalPair = isInFinalPair;
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
          const implicatedFiles = tcResult.implicatedFiles ?? [];
          const outOfScopeFiles = implicatedFiles.filter(
            (f: string) => !declaredFiles.includes(f.replace(/\\/g, '/')),
          );
          const newFiles: string[] = [];
          for (const file of outOfScopeFiles) {
            const normalized = file.replace(/\\/g, '/');
            if (!scopeSet.has(normalized)) {
              scopeSet.add(normalized);
              newFiles.push(normalized);
            }
          }
          if (newFiles.length > 0) {
            const sortedScope = [...scopeSet].sort();
            this.emit(
              input,
              'step.typecheck.scope_widened',
              'warn',
              `step ${input.stepIndex} review-fix iteration ${iterationIndex} widened scope by ${newFiles.length} trusted file(s)`,
              {
                index: input.stepIndex,
                iteration: iterationIndex,
                newlyAddedFiles: newFiles.sort(),
                accumulatedScope: sortedScope,
                implicatedFiles,
                errorCodes: (tcResult.structuredErrors ?? [])
                  .map((e: TypescriptError) => e.code)
                  .sort(),
              },
            );
          }

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

      // --- DIMENSION SCOPE COMPUTATION (#723) ---
      const deltaScopedReReview = opts.deltaScopedReReview ?? true;
      const reviewMode = getReviewMode(iterationIndex, isInFinalPair, deltaScopedReReview);
      const dirtyDims = getDirtyDimensions(dirtyDimensions);
      const specDimensions =
        dirtyDims.includes('spec') || isInFinalPair ? (['spec'] as DimensionName[]) : undefined;
      const qualityDimensions =
        dirtyDims.includes('quality') || isInFinalPair
          ? (['quality'] as DimensionName[])
          : undefined;
      const specScope: ReviewScopeOptions =
        specDimensions !== undefined
          ? { mode: reviewMode, dimensions: specDimensions }
          : { mode: reviewMode };
      const qualityScope: ReviewScopeOptions =
        qualityDimensions !== undefined
          ? { mode: reviewMode, dimensions: qualityDimensions }
          : { mode: reviewMode };

      // --- SPEC-REVIEW ---
      const MAX_SPEC_REVIEW_ATTEMPTS = 3;
      let specReview: SpecReviewResult;
      let specReviewAttempts = 0;
      const specReviewAttemptInvocationIds: string[] = [];
      const shouldReviewSpec = dirtyDims.includes('spec') || isInFinalPair;
      do {
        specReviewAttempts += 1;
        specReview = shouldReviewSpec
          ? await deps.runSpecReview(
              {
                ...ctx,
                metadata: {
                  implementation_task_number: input.stepIndex,
                  iteration: iterationIndex,
                  invocation_type: specReviewAttempts === 1 ? 'initial' : 'retry',
                },
              },
              tcResult,
              specScope,
            )
          : {
              invocationId: '',
              agentOutcome: 'success' as const,
              verdict: 'pass' as const,
              snapshot: { snapshot: finalPairSpecSnapshot ?? '' },
            };
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

      // --- UPDATE SPEC DIMENSION STATE (#723) ---
      if (shouldReviewSpec) {
        if (specReview.verdict === 'pass') {
          dirtyDimensions = markDimensionClean(dirtyDimensions, 'spec');
        } else if (specReview.verdict === 'fail') {
          isInFinalPair = false;
          const prevState = dirtyDimensions.spec;
          dirtyDimensions = markDimensionDirty(
            dirtyDimensions,
            'spec',
            prevState === 'clean' ? 'dirty' : 'recurred',
          );
        }
        persistReviewState();
        if (deps.reviewStateRepository && specReview.agentOutcome === 'success') {
          const snapshot = specReview.snapshot as { snapshot: string } | undefined;
          const attemptArgs = {
            attemptId: specReview.invocationId,
            runId: input.runId as string,
            reviewMode,
            dimension: 'spec' as DimensionName,
            step: String(input.stepIndex),
            now: deps.now,
            ...(snapshot ? { snapshot } : {}),
            ...(specReview.verdict ? { verdict: specReview.verdict } : {}),
          };
          deps.reviewStateRepository.appendAttempt(buildReviewAttempt(attemptArgs));
          deps.reviewStateRepository.upsertDimensionState(
            input.runId as string,
            'implement',
            String(input.stepIndex),
            buildDimensionState({
              dimension: 'spec',
              state: dirtyDimensions.spec,
              ...(snapshot ? { snapshot } : {}),
              ...(specReview.verdict ? { verdict: specReview.verdict } : {}),
            }),
          );
        }
      }

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
      const MAX_QUALITY_REVIEW_ATTEMPTS = 3;
      let qualityReview: QualityReviewResult;
      let qualityReviewAttempts = 0;
      const qualityReviewAttemptInvocationIds: string[] = [];
      const shouldReviewQuality = dirtyDims.includes('quality') || isInFinalPair;
      do {
        qualityReviewAttempts += 1;
        qualityReview = shouldReviewQuality
          ? await deps.runQualityReview(
              {
                ...ctx,
                metadata: {
                  implementation_task_number: input.stepIndex,
                  iteration: iterationIndex,
                  invocation_type: qualityReviewAttempts === 1 ? 'initial' : 'retry',
                },
              },
              tcResult,
              qualityScope,
            )
          : {
              invocationId: '',
              agentOutcome: 'success' as const,
              verdict: 'pass' as const,
              snapshot: { snapshot: finalPairQualitySnapshot ?? '' },
            };
        qualityReviewAttemptInvocationIds.push(qualityReview.invocationId);
        if (qualityReview.agentOutcome === 'success' && qualityReview.verdict !== undefined) {
          break;
        }
        if (qualityReviewAttempts < MAX_QUALITY_REVIEW_ATTEMPTS) {
          this.emit(
            input,
            'step.quality-review.retry',
            'warn',
            `quality-review attempt ${qualityReviewAttempts} failed (invocation ${qualityReview.invocationId}), retrying...`,
            {
              attempt: qualityReviewAttempts,
              maxAttempts: MAX_QUALITY_REVIEW_ATTEMPTS,
              agentOutcome: qualityReview.agentOutcome,
              hasVerdict: qualityReview.verdict !== undefined,
              invocationId: qualityReview.invocationId,
            },
          );
        }
      } while (qualityReviewAttempts < MAX_QUALITY_REVIEW_ATTEMPTS);

      // --- UPDATE QUALITY DIMENSION STATE (#723) ---
      if (shouldReviewQuality) {
        if (qualityReview.verdict === 'pass') {
          dirtyDimensions = markDimensionClean(dirtyDimensions, 'quality');
        } else if (qualityReview.verdict === 'fail') {
          isInFinalPair = false;
          const prevState = dirtyDimensions.quality;
          dirtyDimensions = markDimensionDirty(
            dirtyDimensions,
            'quality',
            prevState === 'clean' ? 'dirty' : 'recurred',
          );
        }
        persistReviewState();
        if (deps.reviewStateRepository && qualityReview.agentOutcome === 'success') {
          const snapshot = qualityReview.snapshot as { snapshot: string } | undefined;
          const attemptArgs = {
            attemptId: qualityReview.invocationId,
            runId: input.runId as string,
            reviewMode,
            dimension: 'quality' as DimensionName,
            step: String(input.stepIndex),
            now: deps.now,
            ...(snapshot ? { snapshot } : {}),
            ...(qualityReview.verdict ? { verdict: qualityReview.verdict } : {}),
          };
          deps.reviewStateRepository.appendAttempt(buildReviewAttempt(attemptArgs));
          deps.reviewStateRepository.upsertDimensionState(
            input.runId as string,
            'implement',
            String(input.stepIndex),
            buildDimensionState({
              dimension: 'quality',
              state: dirtyDimensions.quality,
              ...(snapshot ? { snapshot } : {}),
              ...(qualityReview.verdict ? { verdict: qualityReview.verdict } : {}),
            }),
          );
        }
      }

      this.emit(
        input,
        'step.quality-review.attempts',
        'info',
        `quality-review completed after ${qualityReviewAttempts} attempt(s)`,
        {
          index: iterationIndex,
          attempts: qualityReviewAttempts,
          invocationIds: qualityReviewAttemptInvocationIds,
        },
      );

      loop = updateOpenIteration(loop, { qualityReviewInvocationId: qualityReview.invocationId });
      deps.loops.update(loop);
      if (qualityReview.agentOutcome !== 'success' || qualityReview.verdict === undefined) {
        loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'failed');
        return { outcome: 'failed', loop };
      }

      // --- FINAL PAIR HEAD CHECK (#723) ---
      // Always check HEAD when in final pair mode, regardless of dimension state.
      // This catches HEAD changes even when a reviewer has failed.
      if (startedInFinalPair) {
        const currentHead = await deps.git?.headCommitSha(ctx.cwd);
        if (currentHead !== finalPairCandidateHead) {
          this.emit(
            input,
            'loop.final_pair.head_changed',
            'warn',
            `final pair HEAD mismatch: expected ${finalPairCandidateHead}, got ${currentHead}`,
            { expected: finalPairCandidateHead, actual: currentHead, iterationIndex },
          );
          // HEAD changed - update candidate head and clear snapshots to start new final pair
          finalPairCandidateHead = currentHead;
          finalPairSpecSnapshot = undefined;
          finalPairQualitySnapshot = undefined;
          persistReviewState();
          loop = completeIteration(loop, { outcome: 'unresolved', now: deps.now() });
          deps.loops.update(loop);
          await appendHistory(
            buildHistoryEntry(
              iterationIndex,
              specReview,
              qualityReview,
              undefined,
              undefined,
              'unresolved',
            ),
          );
          this.emitIterationCompleted(input, iterationIndex, 'unresolved');
          continue;
        }
      }

      // --- FINAL PAIR STABILITY CHECK (#723) ---
      // When both dimensions are clean and we're in final pair mode,
      // verify snapshots match for stability confirmation
      if (areAllDimensionsClean(dirtyDimensions) && isInFinalPair) {
        const specSnapshot = specReview.snapshot?.snapshot ?? '';
        const qualitySnapshot = qualityReview.snapshot?.snapshot ?? '';
        const snapshotsMatch =
          specSnapshot === finalPairSpecSnapshot && qualitySnapshot === finalPairQualitySnapshot;
        if (snapshotsMatch) {
          const currentHead = await deps.git?.headCommitSha(ctx.cwd);
          this.emit(
            input,
            'loop.final_pair.confirmed',
            'info',
            `final pair confirmed: HEAD and snapshots stable`,
            { head: currentHead, iterationIndex },
          );
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
        // Snapshots changed - continue to capture new baseline
        finalPairSpecSnapshot = specSnapshot;
        finalPairQualitySnapshot = qualitySnapshot;
        persistReviewState();
        loop = completeIteration(loop, { outcome: 'unresolved', now: deps.now() });
        deps.loops.update(loop);
        await appendHistory(
          buildHistoryEntry(
            iterationIndex,
            specReview,
            qualityReview,
            undefined,
            undefined,
            'unresolved',
          ),
        );
        this.emitIterationCompleted(input, iterationIndex, 'unresolved');
        continue;
      }

      if (specReview.verdict === 'pass' && qualityReview.verdict === 'pass') {
        // All dimensions clean - enter final pair tracking on next iteration
        if (areAllDimensionsClean(dirtyDimensions) && !isInFinalPair) {
          const head = await deps.git?.headCommitSha(ctx.cwd);
          if (head) {
            isInFinalPair = true;
            finalPairCandidateHead = head;
            finalPairSpecSnapshot = specReview.snapshot?.snapshot ?? '';
            finalPairQualitySnapshot = qualityReview.snapshot?.snapshot ?? '';
            this.emit(
              input,
              'loop.final_pair.candidate',
              'info',
              `entering final pair candidate state`,
              { head, iterationIndex },
            );
            persistReviewState();
            loop = completeIteration(loop, { outcome: 'unresolved', now: deps.now() });
            deps.loops.update(loop);
            await appendHistory(
              buildHistoryEntry(
                iterationIndex,
                specReview,
                qualityReview,
                undefined,
                undefined,
                'unresolved',
              ),
            );
            this.emitIterationCompleted(input, iterationIndex, 'unresolved');
            continue;
          }
        }
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
      const escalateForProductiveChurn =
        consecutiveFixedWithoutResolution >= PRODUCTIVE_CHURN_THRESHOLD;

      let useFallback = false;
      let currentFallbackReason: string | undefined = undefined;

      if (escalateForFixFailures) {
        useFallback = deps.fixFallbackProfile !== undefined;
        if (useFallback) {
          currentFallbackReason = 'two_consecutive_fix_failures';
          this.emitEscalation(
            input,
            'two_consecutive_fix_failures',
            deps.fixProfile,
            deps.fixFallbackProfile!,
          );
        }
      } else if (escalateForProductiveChurn) {
        if (deps.fixFallbackProfile !== undefined) {
          useFallback = true;
          currentFallbackReason = 'non_convergent_fixed_iterations';
          if (!emittedProductiveChurnEscalation) {
            emittedProductiveChurnEscalation = true;
            this.emitEscalation(
              input,
              'non_convergent_fixed_iterations',
              deps.fixProfile,
              deps.fixFallbackProfile,
              { count: consecutiveFixedWithoutResolution, threshold: PRODUCTIVE_CHURN_THRESHOLD },
            );
          }
        } else {
          if (!emittedProductiveChurnDiagnostic) {
            emittedProductiveChurnDiagnostic = true;
            this.emit(
              input,
              'loop.productive_churn.diagnostic',
              'warn',
              'productive-churn escalation triggered but no fallback profile is configured',
              { count: consecutiveFixedWithoutResolution, threshold: PRODUCTIVE_CHURN_THRESHOLD },
            );
          }
        }
      }

      // --- TRAILING RE-REVIEW SHORT-CIRCUIT (#680) ---
      // Reviews already ran above (the trailing pass skips `runFix`). If
      // either review failed, the existing branch at line ~533 already
      // fell through to the `runFix` invocation; intercept that here.
      if (isTrailingReview) {
        // --- ARBITER ESCALATION (#690) ---
        // No fixer ran this pass, so there is no review/fix contradiction to
        // detect — go straight to arbitration on the failing verdict itself.
        if (deps.runFinalReviewArbiter !== undefined) {
          this.emit(
            input,
            'loop.trailing_review.arbiter_escalated',
            'warn',
            `escalating trailing re-review fail to arbiter at iteration ${iterationIndex}`,
            { reason: 'trailing_review_fail', iterationIndex },
          );
          const arbiterResult: ArbiterResult = await deps.runFinalReviewArbiter(
            {
              ...ctx,
              metadata: {
                implementation_task_number: input.stepIndex,
                iteration: iterationIndex,
                invocation_type: 'initial',
              },
            },
            tcResult,
            specReview,
            qualityReview,
          );
          if (!arbiterResult.evidence || arbiterResult.evidence.trim().length === 0) {
            this.emit(
              input,
              'needs_human_review',
              'warn',
              `trailing review arbiter returned empty evidence at iteration ${iterationIndex} — escalating to human`,
              { iterationIndex, outcome: arbiterResult.outcome },
            );
            loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
            deps.loops.update(loop);
            return { outcome: 'needs_human_review', loop };
          }
          if (arbiterResult.outcome === 'finding_invalid') {
            this.emit(
              input,
              'loop.trailing_review.arbiter_resolved',
              'info',
              `arbiter resolved trailing review fail at iteration ${iterationIndex}: ${arbiterResult.outcome}`,
              {
                ruling: arbiterResult.outcome,
                resolvedBy: 'trailing-review-arbiter',
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
                undefined,
                undefined,
                'resolved',
                undefined,
                arbiterResult,
              ),
            );
            this.emitIterationCompleted(input, iterationIndex, 'resolved', {
              resolvedBy: 'trailing-review-arbiter',
            });
            return { outcome: 'success', loop };
          }

          if (
            arbiterResult.outcome === 'finding_valid' &&
            !bonusIterationUsed &&
            opts.bonusIteration !== false
          ) {
            this.emit(
              input,
              'loop.trailing_review.bonus_fix_iteration',
              'info',
              `granting one-time bonus fix iteration for valid trailing finding at iteration ${iterationIndex}`,
              { iterationIndex, rationale: arbiterResult.rationale },
            );
            bonusIterationUsed = true;
            pendingReconciliationContext = arbiterResult.rationale;

            // Perform the bonus fix iteration immediately
            const bonusFixHistory = await readFixerHistory();
            const bonusFixHistoryContext = bonusFixHistory
              ? formatFixerHistory(bonusFixHistory)
              : undefined;
            const thresholdIteration = opts.holisticThresholdIteration ?? 3;
            const thresholdFindings = opts.holisticThresholdFindings ?? 2;
            const bonusHolisticFindings = bonusFixHistory
              ? detectHolisticFiles(
                  bonusFixHistory,
                  [...(specReview.findings ?? []), ...(qualityReview.findings ?? [])],
                  iterationIndex,
                  thresholdIteration,
                  thresholdFindings,
                )
              : undefined;

            if (bonusHolisticFindings) {
              for (const h of bonusHolisticFindings) {
                this.emit(
                  input,
                  'fix.holistic_rederivation',
                  'info',
                  `holistic re-derivation triggered for ${h.file}`,
                  {
                    file: h.file,
                    iteration: iterationIndex,
                    findings: h.findings.filter((f) => f.status === 'resolved').length,
                    totalFindings: h.findings.length,
                  },
                );
              }
            }

            const bonusFix = await deps.runFix(
              {
                ...ctx,
                metadata: {
                  implementation_task_number: input.stepIndex,
                  iteration: iterationIndex,
                  invocation_type: 'initial',
                },
              },
              {
                useFallback: false,
                ...(bonusFixHistoryContext !== undefined
                  ? { historyContext: bonusFixHistoryContext }
                  : {}),
                reconciliationContext: pendingReconciliationContext,
                ...(bonusHolisticFindings ? { holisticFindings: bonusHolisticFindings } : {}),
                ...(scopeSet.size > 0 ? { additionalEditableFiles: [...scopeSet].sort() } : {}),
              },
            );
            pendingReconciliationContext = undefined;
            lastFixInvocationId = bonusFix.invocationId;
            lastFixHeadBeforeFix = bonusFix.headBeforeFix;

            if (
              bonusFix.agentOutcome !== 'success' ||
              bonusFix.verdict === undefined ||
              bonusFix.verdict === 'cannot_fix'
            ) {
              loop = completeIteration(loop, {
                outcome: 'unresolved',
                fixInvocationId: bonusFix.invocationId,
                now: deps.now(),
              });
              deps.loops.update(loop);
              await appendHistory(
                buildHistoryEntry(
                  iterationIndex,
                  specReview,
                  qualityReview,
                  bonusFix,
                  undefined,
                  'unresolved',
                ),
              );
              this.emitIterationCompleted(input, iterationIndex, 'unresolved');
              // bonusIterationUsed is already true, so the loop will exhaust
              break;
            }

            // Verify the bonus fix
            if (
              bonusFix.verdict === 'done_with_fixes' &&
              bonusFix.headBeforeFix !== undefined &&
              deps.git
            ) {
              const verification:
                | FixCommitVerification
                | { kind: 'verification_error'; error: string } = await verifyFixCommit({
                git: deps.git,
                cwd: ctx.cwd,
                expectedHead: bonusFix.headBeforeFix,
              });
              if (
                verification.kind === 'uncommitted_changes' ||
                verification.kind === 'no_commit_claimed' ||
                verification.kind === 'verification_error'
              ) {
                loop = completeIteration(loop, {
                  outcome: 'unresolved',
                  fixInvocationId: bonusFix.invocationId,
                  now: deps.now(),
                });
                deps.loops.update(loop);
                await appendHistory(
                  buildHistoryEntry(
                    iterationIndex,
                    specReview,
                    qualityReview,
                    bonusFix,
                    undefined,
                    'unresolved',
                    verification.kind !== 'verification_error' ? verification : undefined,
                  ),
                );
                this.emitIterationCompleted(input, iterationIndex, 'unresolved');
                break;
              }
            }

            loop = completeIteration(loop, {
              outcome: 'fixed',
              fixInvocationId: bonusFix.invocationId,
              now: deps.now(),
            });
            // Bump maxIterations to allow the new trailing review pass
            loop = { ...loop, maxIterations: loop.maxIterations + 1 };
            deps.loops.update(loop);
            await appendHistory(
              buildHistoryEntry(
                iterationIndex,
                specReview,
                qualityReview,
                bonusFix,
                undefined,
                'fixed',
              ),
            );
            this.emitIterationCompleted(input, iterationIndex, 'fixed');
            continue;
          }
          // arbiterResult.outcome is 'ambiguous' | 'insufficient_evidence':
          // fall through to the same unresolved/exhaust path as the no-arbiter case below.
        }

        loop = completeIteration(loop, { outcome: 'unresolved', now: deps.now() });
        deps.loops.update(loop);
        await appendHistory(
          buildHistoryEntry(
            iterationIndex,
            specReview,
            qualityReview,
            undefined,
            undefined,
            'unresolved',
          ),
        );
        this.emitIterationCompleted(input, iterationIndex, 'unresolved');
        break;
      }

      // --- FIX ---
      const fixHistory = await readFixerHistory();
      const historyContext = fixHistory ? formatFixerHistory(fixHistory) : undefined;
      const thresholdIteration = opts.holisticThresholdIteration ?? 3;
      const thresholdFindings = opts.holisticThresholdFindings ?? 2;
      const holisticFindings = fixHistory
        ? detectHolisticFiles(
            fixHistory,
            [...(specReview.findings ?? []), ...(qualityReview.findings ?? [])],
            iterationIndex,
            thresholdIteration,
            thresholdFindings,
          )
        : undefined;

      if (holisticFindings) {
        for (const h of holisticFindings) {
          this.emit(
            input,
            'fix.holistic_rederivation',
            'info',
            `holistic re-derivation triggered for ${h.file}`,
            {
              file: h.file,
              iteration: iterationIndex,
              findings: h.findings.filter((f) => f.status === 'resolved').length,
              totalFindings: h.findings.length,
            },
          );
        }
      }

      const fix = await deps.runFix(
        {
          ...ctx,
          metadata: {
            implementation_task_number: input.stepIndex,
            iteration: iterationIndex,
            invocation_type: 'initial',
          },
        },
        {
          useFallback,
          ...(currentFallbackReason !== undefined ? { fallbackReason: currentFallbackReason } : {}),
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
          ...(holisticFindings ? { holisticFindings } : {}),
          ...(scopeSet.size > 0 ? { additionalEditableFiles: [...scopeSet].sort() } : {}),
        },
      );
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
          const contradictionScope: ReviewScopeOptions = {
            mode: 'intermediate_delta',
          };
          let rerunSpec = specReview;
          if (specReview.verdict === 'fail') {
            rerunSpec = await deps.runSpecReview(ctx, tcResult, {
              ...contradictionScope,
              dimensions: ['spec'],
            });
            this.emit(
              input,
              'step.spec-review.attempts',
              'info',
              `spec-review completed after 1 attempt(s)`,
              {
                index: iterationIndex,
                attempts: 1,
                invocationIds: [rerunSpec.invocationId],
              },
            );
          }
          let rerunQuality = qualityReview;
          if (qualityReview.verdict === 'fail') {
            rerunQuality = await deps.runQualityReview(ctx, tcResult, {
              ...contradictionScope,
              dimensions: ['quality'],
            });
            this.emit(
              input,
              'step.quality-review.attempts',
              'info',
              `quality-review completed after 1 attempt(s)`,
              {
                index: iterationIndex,
                attempts: 1,
                invocationIds: [rerunQuality.invocationId],
              },
            );
          }
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
          const arbiterResult = await deps.runArbiter(
            {
              ...ctx,
              metadata: {
                implementation_task_number: input.stepIndex,
                iteration: iterationIndex,
                invocation_type: 'initial',
              },
            },
            tcResult,
            fix,
          );
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
                undefined,
                arbiterResult,
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

          // --- AUTO-COMMIT FALLBACK ---
          // If the worktree is dirty but valid (passes typecheck), auto-commit on the
          // agent's behalf so correct work isn't lost to minor git/hook failures.
          tcResult = await deps.runTypecheck(baseCtx);
          let autoCommitted = false;
          if (tcResult.outcome === 'pass') {
            const message = `fix: ${input.stepTitle} (auto-committed — agent left changes uncommitted)`;
            let committedSha: string | undefined;

            for (let attempt = 1; attempt <= 2; attempt++) {
              try {
                await this.deps.git!.addAll(baseCtx.cwd);
                committedSha = await this.deps.git!.commit(baseCtx.cwd, message);
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
                `auto-committed ${verification.dirtyFiles.length} dirty file(s) after passing typecheck`,
                { sha: committedSha, iterationIndex },
              );
              autoCommitted = true;
              // Success: treat this as a productive fix that advanced HEAD.
              consecutiveFixFailures = 0;
              lastFixHeadBeforeFix = undefined;
              loop = completeIteration(loop, {
                outcome: 'fixed',
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
                  'fixed',
                ),
              );
              this.emitIterationCompleted(input, iterationIndex, 'fixed');
              // Fall through to the next iteration (re-review).
            }
          }

          if (!autoCommitted) {
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
          // If we autoCommitted, we fall out of the `uncommitted_changes` block and
          // continue the loop (bypassing the Redundant `fixed` completion).
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

    // --- TERMINAL FIX ESCALATION ---
    if (deps.terminalFixProfile !== undefined) {
      this.emit(
        input,
        'step.terminal_fix.started',
        'info',
        `escalating to terminal fixer (${deps.terminalFixProfile}) after loop exhaustion`,
        { profile: deps.terminalFixProfile, priorIterations: loop.iterations.length },
      );

      const terminalFixHistory = await readFixerHistory();
      const historyContext = terminalFixHistory
        ? formatFixerHistory(terminalFixHistory)
        : undefined;

      const thresholdIteration = opts.holisticThresholdIteration ?? 3;
      const thresholdFindings = opts.holisticThresholdFindings ?? 2;
      const terminalHolisticFindings = terminalFixHistory
        ? detectHolisticFiles(
            terminalFixHistory,
            [], // Terminal fix addresses all open findings in history
            loop.iterations.length,
            thresholdIteration,
            thresholdFindings,
          )
        : undefined;

      if (terminalHolisticFindings) {
        for (const h of terminalHolisticFindings) {
          this.emit(
            input,
            'fix.holistic_rederivation',
            'info',
            `holistic re-derivation triggered for ${h.file} (terminal fix)`,
            {
              file: h.file,
              iteration: loop.iterations.length,
              findings: h.findings.filter((f) => f.status === 'resolved').length,
              totalFindings: h.findings.length,
              isTerminalFix: true,
            },
          );
        }
      }

      // Deterministic pre-verification: typecheck + validation commands + tests.
      const preTcResult = await deps.runTypecheck(baseCtx);
      let preRevalidationPassed = true;
      let preRevalidationDetail: string | undefined;

      if (preTcResult.outcome === 'pass' && deps.runRevalidation) {
        const revalResult = await deps.runRevalidation(baseCtx);
        preRevalidationPassed = revalResult.passed;
        preRevalidationDetail = revalResult.failureDetail;
      }

      let terminalDeterministicFailures: string | undefined;
      if (preTcResult.outcome === 'fail' || !preRevalidationPassed) {
        const failures: string[] = [];
        if (preTcResult.outcome === 'fail') {
          failures.push(`Typecheck failed:\n${preTcResult.output}`);
        }
        if (!preRevalidationPassed && preRevalidationDetail) {
          failures.push(preRevalidationDetail);
        }
        terminalDeterministicFailures = failures.join('\n\n---\n\n');
      }

      const terminalFixStart = deps.now();
      const terminalFix = await deps.runFix(
        {
          ...baseCtx,
          iterationIndex: loop.iterations.length, // use last iteration index for context
          metadata: {
            implementation_task_number: input.stepIndex,
            iteration: loop.iterations.length,
            invocation_type: 'terminal_fix',
          },
        },
        {
          useFallback: false,
          isTerminalFix: true,
          ...(terminalDeterministicFailures !== undefined ? { terminalDeterministicFailures } : {}),
          ...(historyContext !== undefined ? { historyContext } : {}),
          ...(terminalHolisticFindings ? { holisticFindings: terminalHolisticFindings } : {}),
          ...(scopeSet.size > 0 ? { additionalEditableFiles: [...scopeSet].sort() } : {}),
        },
      );

      // cannot_fix is an explicit surrender — respect it without salvage.
      if (terminalFix.verdict === 'cannot_fix') {
        this.emit(
          input,
          'step.terminal_fix.failed',
          'error',
          `terminal fixer declared cannot_fix`,
          {
            profile: deps.terminalFixProfile,
            priorIterations: loop.iterations.length,
            agentOutcome: terminalFix.agentOutcome,
            verdict: terminalFix.verdict,
          },
        );
        return { outcome: 'needs_human_review', loop };
      }

      // #763 design addendum: the fixer's self-reported result artifact is
      // informational, never load-bearing. When a git port is available,
      // assess whether the fixer produced work from git state — HEAD
      // advanced, or a dirty tree that auto-commits after passing typecheck
      // (the run-83e8f9aa iteration-5 failure discarded a fully verified fix
      // over a missing result.json; this branch must not repeat that).
      // Without a git port, fall back to the verdict artifact.
      let producedWork =
        terminalFix.agentOutcome === 'success' && terminalFix.verdict === 'done_with_fixes';
      let headAdvanced = false;
      let autoCommitted = false;
      let typecheckAfterFix: TypecheckResult | undefined;

      if (deps.git) {
        const headAfter = await deps.git.headCommitSha(baseCtx.cwd);
        headAdvanced =
          terminalFix.headBeforeFix !== undefined &&
          headAfter !== undefined &&
          headAfter !== terminalFix.headBeforeFix;
        const statusOutput = await deps.git.status(baseCtx.cwd);
        const dirty = statusOutput.trim().length > 0;

        if (dirty) {
          // Never commit a broken tree: typecheck gates the auto-commit. A
          // failed commit is not retried — the clean outcome below is
          // needs_human_review, and the dirty state is preserved for the
          // human (#679 precedent: never revert uncommitted agent work).
          typecheckAfterFix = await deps.runTypecheck(baseCtx);
          if (typecheckAfterFix.outcome === 'pass') {
            try {
              await deps.git.addAll(baseCtx.cwd);
              await deps.git.commit(
                baseCtx.cwd,
                `fix: ${input.stepTitle} (terminal fix — auto-committed)`,
              );
              autoCommitted = true;
            } catch {
              // fall through: producedWork reflects headAdvanced only
            }
          }
        }
        producedWork = headAdvanced || autoCommitted;
      }

      // A clean tree with `done_no_fixes_needed` is not a failure — it is the
      // terminal fixer rebutting the outstanding findings ("the code is
      // already correct; nothing to change"). Trust the rebuttal exactly the
      // way a terminal fix is trusted: the deterministic gate on the current
      // tree decides. The whole-PR review downstream remains the backstop if
      // the rebuttal is wrong. Only a fixer that CLAIMED fixes but produced
      // none (or crashed) is untrustworthy.
      const isTerminalRebuttal =
        terminalFix.agentOutcome === 'success' && terminalFix.verdict === 'done_no_fixes_needed';

      if (!producedWork && isTerminalRebuttal) {
        // Rebuttals cannot clear deterministic failures.
        if (preTcResult.outcome === 'fail' || !preRevalidationPassed) {
          this.emit(
            input,
            'step.terminal_fix.rejected',
            'warn',
            `terminal fixer rebutted the outstanding findings but the tree has pre-existing deterministic failures that must be fixed`,
            {
              profile: deps.terminalFixProfile,
              priorIterations: loop.iterations.length,
              typecheckOutcome: preTcResult.outcome,
              revalidationPassed: preRevalidationPassed,
            },
          );
          return { outcome: 'needs_human_review', loop };
        }
      }

      if (!producedWork && !isTerminalRebuttal) {
        this.emit(
          input,
          'step.terminal_fix.failed',
          'error',
          `terminal fixer produced no verifiable work (agentOutcome: ${terminalFix.agentOutcome}, verdict: ${String(terminalFix.verdict)})`,
          {
            profile: deps.terminalFixProfile,
            priorIterations: loop.iterations.length,
            agentOutcome: terminalFix.agentOutcome,
            verdict: terminalFix.verdict,
            headAdvanced,
            autoCommitted,
          },
        );
        return { outcome: 'needs_human_review', loop };
      }

      // Deterministic verification: typecheck + validation commands + tests.
      let tcResult: TypecheckResult;
      let revalidationPassed = true;
      let revalidationDurationMs = 0;

      if (!producedWork && isTerminalRebuttal) {
        // Optimization: reuse pre-verify result for rebuttals on an identical tree.
        tcResult = preTcResult;
        revalidationPassed = preRevalidationPassed;
      } else {
        // The auto-commit path already typechecked this exact tree content;
        // reuse that result rather than re-running.
        tcResult = typecheckAfterFix ?? (await deps.runTypecheck(baseCtx));

        if (tcResult.outcome === 'pass' && deps.runRevalidation) {
          const revalStart = deps.now();
          const revalResult = await deps.runRevalidation(baseCtx);
          revalidationPassed = revalResult.passed;
          revalidationDurationMs = deps.now().getTime() - revalStart.getTime();
        }
      }

      const verificationPassed = tcResult.outcome === 'pass' && revalidationPassed;

      if (verificationPassed) {
        this.emit(
          input,
          'step.terminal_fix.accepted',
          'info',
          isTerminalRebuttal && !producedWork
            ? `terminal fixer rebutted the outstanding findings; current tree accepted after successful deterministic verification`
            : `terminal fix accepted after successful deterministic verification`,
          {
            profile: deps.terminalFixProfile,
            priorIterations: loop.iterations.length,
            durationMs: deps.now().getTime() - terminalFixStart.getTime(),
            revalidationDurationMs,
            headAdvanced,
            autoCommitted,
            verdictArtifact: terminalFix.verdict ?? null,
            resolvedBy: isTerminalRebuttal && !producedWork ? 'terminal_rebuttal' : 'terminal_fix',
            ...(isTerminalRebuttal && terminalFix.rebuttal
              ? { rebuttal: terminalFix.rebuttal }
              : {}),
          },
        );
        return { outcome: 'success', loop };
      }
      this.emit(
        input,
        'step.terminal_fix.rejected',
        'warn',
        `terminal fix rejected: deterministic verification failed`,
        {
          profile: deps.terminalFixProfile,
          priorIterations: loop.iterations.length,
          typecheckOutcome: tcResult.outcome,
          revalidationPassed,
          headAdvanced,
          autoCommitted,
        },
      );
      return { outcome: 'needs_human_review', loop };
    }

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
    extraMetadata?: Record<string, unknown>,
  ): void {
    this.emit(
      input,
      'loop.iteration.completed',
      'info',
      `iteration ${index} completed: ${outcome}`,
      { ...extraMetadata, index, outcome },
    );
  }

  private async runImplementWithFallback(
    input: ImplementStepLoopInput,
    ctx: StepLoopContext,
    opts?: ImplementStepOptions,
  ): Promise<ImplementResult> {
    const { deps } = this;
    const result = await deps.runImplement(ctx, opts);

    if (result.agentOutcome !== 'success' && deps.implementFallbackProfile) {
      this.emitEscalation(
        input,
        'implement_failed',
        deps.implementProfile,
        deps.implementFallbackProfile,
      );
      return deps.runImplement(ctx, {
        ...opts,
        useFallback: true,
        previousInvocationId: result.invocationId,
      });
    }

    return result;
  }

  private emitEscalation(
    input: ImplementStepLoopInput,
    triggerReason: string,
    fromProfile: AgentProfileName,
    toProfile: AgentProfileName,
    extraMetadata?: Record<string, unknown>,
  ): void {
    this.emit(input, 'phase.fallback.escalated', 'warn', `escalating phase to ${toProfile}`, {
      fromProfile: fromProfile as unknown as string,
      toProfile: toProfile as unknown as string,
      triggerReason,
      triggerOwner: 'use_case',
      ...extraMetadata,
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

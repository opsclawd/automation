import type {
  Run,
  Phase,
  PhaseStatus,
  Failure,
  ResumeDisposition,
  Step,
  RunId,
} from '@ai-sdlc/domain';
import {
  PhaseName,
  startPhase,
  completePhase,
  skipPhase,
  failRun,
  passRun,
  blockRun,
  markRunNeedsHumanReview,
} from '@ai-sdlc/domain';
import type { PhaseHandlerContext, PhaseResult } from '../phases/handler.js';
import type { PhaseDefinition } from '../phases/phase-definitions.js';
import {
  CANONICAL_PHASE_ORDER,
  PHASE_DEFINITIONS,
  getPhaseDefinition,
  orderedPhases,
  assertInputsAvailable,
  MissingRequiredInputError,
  resolvePhaseGraph,
} from '../phases/index.js';
import type { RunRepositoryPort, FailureRepositoryPort, LoggerPort } from '../ports.js';
import type { PhaseRepositoryPort } from '../ports/phase-repository-port.js';
import type { EventBusPort } from '../ports/event-bus-port.js';
import type { PhaseHandlerRegistryPort } from '../ports/phase-handler-registry-port.js';
import type {
  WorktreeLifecyclePort,
  WorktreeLifecyclePlan,
} from '../ports/worktree-lifecycle-port.js';
import type { EventRepositoryPort } from '../ports/event-repository-port.js';
import type { StepRepositoryPort } from '../ports/step-repository-port.js';
import {
  orchestratorExcludePatterns,
  uncommittedSourcePaths,
  unquoteGitPath,
  isUntrackedOrAddedStatusLine,
} from '../artifacts/orchestrator-artifacts.js';
import {
  normalizeTaskPath,
  classifyTaskChanges,
  loadManifest,
  resolveEffectiveTaskScope,
  isProtectedTaskPath,
  type TaskChangeCandidate,
} from '../task-file-boundaries.js';
import { isProtectedFilePath } from '../scratch-file-remediation.js';

export interface RunExecutorDeps {
  runRepository: RunRepositoryPort;
  failureRepository: FailureRepositoryPort;
  phaseRepository: PhaseRepositoryPort;
  events: EventBusPort;
  registry: PhaseHandlerRegistryPort;
  contextFactory: (run: Run) => PhaseHandlerContext;
  now?: () => Date;
  logger?: LoggerPort;
  worktreeLifecycle?: WorktreeLifecyclePort;
  eventRepository?: EventRepositoryPort;
  stepRepository?: StepRepositoryPort;
  reviewConvergenceMaxIterations?: number;
}

export interface ExecuteRunInput {
  run: Run;
  skip: PhaseName[];
  presentArtifacts: string[];
  resumeDisposition?: ResumeDisposition;
  reviewConvergenceMaxIterations?: number;
}

export interface PhaseRecord {
  phase: PhaseName;
  status: PhaseStatus;
  failure?: Failure;
}

export interface ExecuteRunOutput {
  run: Run;
  phases: PhaseRecord[];
}

interface ExecutionState {
  currentRun: Run;
  skipSet: Set<string>;
  completedSet: Set<string>;
  previouslySkippedSet: Set<string>;
  presentArtifacts: string[];
  storedArtifacts: Set<string> | undefined;
  phases: PhaseRecord[];
  approvedInboundPaths: string[] | undefined;
  now: () => Date;
}

export class HandlerNotWiredError extends Error {
  constructor(phase: string) {
    super(
      `Handler for phase "${phase}" is not wired — register a real PhaseHandler implementation before invoking RunExecutor`,
    );
    this.name = 'HandlerNotWiredError';
  }
}

export class RunExecutor {
  constructor(private readonly deps: RunExecutorDeps) {}

  async execute(input: ExecuteRunInput): Promise<ExecuteRunOutput> {
    const { run, skip } = input;
    const now = this.deps.now ?? (() => new Date());
    const phases: PhaseRecord[] = [];
    const presentArtifacts: string[] = [...input.presentArtifacts];
    let currentRun: Run = { ...run };

    // Validate skip list — throws if a phase isn't skippable or skipping
    // would orphan a required input in a downstream phase
    orderedPhases(skip, undefined, currentRun.executionPolicy);

    const phaseGraph = resolvePhaseGraph(currentRun.executionPolicy);
    const skipSet: Set<string> = new Set(skip.map((s) => s as string));
    const completedSet = new Set(currentRun.completedPhases);
    const previouslySkippedSet = new Set(currentRun.skippedPhases);

    let approvedInboundPaths: string[] | undefined;

    if (input.resumeDisposition !== undefined) {
      const firstIncompletePhase = phaseGraph.getFirstIncompletePhase({
        completedPhases: completedSet,
        skippedPhases: previouslySkippedSet,
        skipSet,
      });

      if (firstIncompletePhase) {
        const firstIncompleteDef = PHASE_DEFINITIONS[firstIncompletePhase]!;
        const ctxForResume = this.deps.contextFactory(run);

        const isImplementPhase = firstIncompletePhase === 'implement';
        let resumableStep: Step | undefined;
        if (this.deps.stepRepository) {
          const runSteps = this.deps.stepRepository.listForRun(run.uuid as RunId);
          const implementSteps = runSteps
            .filter((s) => s.phaseId === 'implement')
            .sort((a, b) => a.index - b.index);
          resumableStep = implementSteps.find((s) => s.status !== 'success');
        }

        if (isImplementPhase && resumableStep !== undefined) {
          if (input.resumeDisposition === 'reset_to_baseline') {
            const baseline = resumableStep.initialPreStepHead;
            if (!baseline || !baseline.trim()) {
              const failureMessage = `step ${resumableStep.index} (${resumableStep.title}) is missing initialPreStepHead baseline; cannot resume with reset_to_baseline`;
              const failure: Failure = {
                runUuid: currentRun.uuid,
                phase: firstIncompletePhase as string,
                kind: 'setup_failed',
                message: failureMessage,
                canRetry: true,
                suggestedAction: 'Inspect the step baseline in the database or reset the run.',
                artifacts: [],
                detectedAt: now(),
              };
              const phase: Phase = {
                id: this.phaseId(currentRun.uuid, firstIncompletePhase),
                runUuid: currentRun.uuid,
                name: firstIncompletePhase as string,
                status: 'needs_human_review',
                attempt: 1,
                startedAt: now(),
                completedAt: now(),
              };
              return this.needsHumanReviewRun(
                currentRun,
                firstIncompleteDef,
                phase,
                failure,
                now(),
                phases,
              );
            }

            if (!this.deps.worktreeLifecycle) {
              const failureMessage = `worktreeLifecycle port is not configured; cannot resume with reset_to_baseline`;
              const failure: Failure = {
                runUuid: currentRun.uuid,
                phase: firstIncompletePhase as string,
                kind: 'setup_failed',
                message: failureMessage,
                canRetry: true,
                suggestedAction: 'Ensure worktreeLifecycle port is wired.',
                artifacts: [],
                detectedAt: now(),
              };
              const phase: Phase = {
                id: this.phaseId(currentRun.uuid, firstIncompletePhase),
                runUuid: currentRun.uuid,
                name: firstIncompletePhase as string,
                status: 'needs_human_review',
                attempt: 1,
                startedAt: now(),
                completedAt: now(),
              };
              return this.needsHumanReviewRun(
                currentRun,
                firstIncompleteDef,
                phase,
                failure,
                now(),
                phases,
              );
            }

            let plan: WorktreeLifecyclePlan;
            try {
              plan = await this.deps.worktreeLifecycle.inspect({
                cwd: ctxForResume.cwd,
                mode: 'resume_baseline',
                targetBaseline: baseline.trim(),
                preservedPatterns: orchestratorExcludePatterns(),
              });
            } catch (err) {
              const failureMessage = `failed to resolve resume baseline ${baseline}: ${err instanceof Error ? err.message : String(err)}`;
              const failure: Failure = {
                runUuid: currentRun.uuid,
                phase: firstIncompletePhase as string,
                kind: 'setup_failed',
                message: failureMessage,
                canRetry: true,
                suggestedAction: 'Ensure the baseline commit exists in the repository.',
                artifacts: [],
                detectedAt: now(),
              };
              const phase: Phase = {
                id: this.phaseId(currentRun.uuid, firstIncompletePhase),
                runUuid: currentRun.uuid,
                name: firstIncompletePhase as string,
                status: 'needs_human_review',
                attempt: 1,
                startedAt: now(),
                completedAt: now(),
              };
              return this.needsHumanReviewRun(
                currentRun,
                firstIncompleteDef,
                phase,
                failure,
                now(),
                phases,
              );
            }

            const resetMessage = `resumed run reset worktree to baseline ${baseline}`;
            const metadata = {
              baseline,
              stepIndex: resumableStep.index,
              discardedPaths: [...plan.discardedPaths].sort(),
              preservedPaths: [...plan.preservedPaths].sort(),
              trackedChanges: [...plan.trackedChanges].sort(),
              untrackedPaths: [...plan.untrackedPaths].sort(),
              fingerprint: plan.fingerprint,
            };

            // Synchronously insert audit record BEFORE mutating Git state.
            // This is a hard (unguarded) call, not `if (this.deps.eventRepository)`:
            // a missing eventRepository must fail the same way an insert
            // failure does (needs_human_review, no mutation), not silently
            // skip the audit and proceed to the destructive reset below.
            try {
              if (!this.deps.eventRepository) {
                throw new Error('eventRepository port is not configured');
              }
              this.deps.eventRepository.insert({
                runUuid: currentRun.uuid,
                phase: firstIncompletePhase as string,
                level: 'info',
                type: 'run.resume_worktree_reset',
                message: resetMessage,
                metadata,
                timestamp: now(),
              });
              this.emit(
                run.displayId,
                run.uuid,
                firstIncompletePhase as string,
                'info',
                'run.resume_worktree_reset',
                resetMessage,
                now(),
                metadata,
              );
            } catch (err) {
              const failureMessage = `failed to insert resume audit event: ${err instanceof Error ? err.message : String(err)}`;
              const failure: Failure = {
                runUuid: currentRun.uuid,
                phase: firstIncompletePhase as string,
                kind: 'setup_failed',
                message: failureMessage,
                canRetry: true,
                suggestedAction: 'Verify database connectivity and disk space.',
                artifacts: [],
                detectedAt: now(),
              };
              const phase: Phase = {
                id: this.phaseId(currentRun.uuid, firstIncompletePhase),
                runUuid: currentRun.uuid,
                name: firstIncompletePhase as string,
                status: 'needs_human_review',
                attempt: 1,
                startedAt: now(),
                completedAt: now(),
              };
              return this.needsHumanReviewRun(
                currentRun,
                firstIncompleteDef,
                phase,
                failure,
                now(),
                phases,
              );
            }

            // Execute reset plan
            try {
              const execResult = await this.deps.worktreeLifecycle.execute({ plan });
              if (!execResult.success) {
                throw new Error('worktree lifecycle execution failed');
              }
            } catch (err) {
              const failureMessage = `failed to execute resume reset plan: ${err instanceof Error ? err.message : String(err)}`;
              const failure: Failure = {
                runUuid: currentRun.uuid,
                phase: firstIncompletePhase as string,
                kind: 'setup_failed',
                message: failureMessage,
                canRetry: true,
                suggestedAction: 'Inspect worktree git state.',
                artifacts: [],
                detectedAt: now(),
              };
              const phase: Phase = {
                id: this.phaseId(currentRun.uuid, firstIncompletePhase),
                runUuid: currentRun.uuid,
                name: firstIncompletePhase as string,
                status: 'needs_human_review',
                attempt: 1,
                startedAt: now(),
                completedAt: now(),
              };
              return this.needsHumanReviewRun(
                currentRun,
                firstIncompleteDef,
                phase,
                failure,
                now(),
                phases,
              );
            }
          } else if (input.resumeDisposition === 'preserve_working_tree') {
            let statusOutput = '';
            try {
              statusOutput = await ctxForResume.git.status(ctxForResume.cwd);
            } catch (err) {
              const failureMessage = `failed to check git status for preserve resume: ${err instanceof Error ? err.message : String(err)}`;
              const failure: Failure = {
                runUuid: currentRun.uuid,
                phase: firstIncompletePhase as string,
                kind: 'setup_failed',
                message: failureMessage,
                canRetry: true,
                suggestedAction: 'Inspect git repository accessibility.',
                artifacts: [],
                detectedAt: now(),
              };
              const phase: Phase = {
                id: this.phaseId(currentRun.uuid, firstIncompletePhase),
                runUuid: currentRun.uuid,
                name: firstIncompletePhase as string,
                status: 'needs_human_review',
                attempt: 1,
                startedAt: now(),
                completedAt: now(),
              };
              return this.needsHumanReviewRun(
                currentRun,
                firstIncompleteDef,
                phase,
                failure,
                now(),
                phases,
              );
            }

            const isLeanPolicy =
              currentRun.executionPolicy === 'standard' || currentRun.executionPolicy === 'strict';

            if (isLeanPolicy) {
              const dirtySourcePaths = uncommittedSourcePaths(statusOutput)
                .map(normalizeTaskPath)
                .filter(Boolean);

              const unapprovedPaths = dirtySourcePaths.filter(
                (p) => isProtectedFilePath(p) || isProtectedTaskPath(p),
              );

              if (unapprovedPaths.length > 0) {
                const failureMessage = `preserve mode rejected unpermitted dirty paths in worktree: ${unapprovedPaths.join(', ')}`;
                const failure: Failure = {
                  runUuid: currentRun.uuid,
                  phase: firstIncompletePhase as string,
                  kind: 'setup_failed',
                  message: failureMessage,
                  canRetry: true,
                  suggestedAction: 'Clean or revert unpermitted dirty files before resuming.',
                  artifacts: [],
                  detectedAt: now(),
                };
                const phase: Phase = {
                  id: this.phaseId(currentRun.uuid, firstIncompletePhase),
                  runUuid: currentRun.uuid,
                  name: firstIncompletePhase as string,
                  status: 'needs_human_review',
                  attempt: 1,
                  startedAt: now(),
                  completedAt: now(),
                };
                return this.needsHumanReviewRun(
                  currentRun,
                  firstIncompleteDef,
                  phase,
                  failure,
                  now(),
                  phases,
                );
              }

              approvedInboundPaths = [...dirtySourcePaths].sort();
            } else {
              const manifestResult = await loadManifest(
                { runId: run.uuid },
                { cwd: ctxForResume.cwd, runId: run.uuid },
                {
                  artifactStore: ctxForResume.artifacts,
                  readWorktreeFile: ctxForResume.readWorktreeFile,
                },
              );

              if (manifestResult.status !== 'found') {
                const failureMessage = `cannot preserve working tree: ${manifestResult.message}`;
                const failure: Failure = {
                  runUuid: currentRun.uuid,
                  phase: firstIncompletePhase as string,
                  kind: 'setup_failed',
                  message: failureMessage,
                  canRetry: true,
                  suggestedAction: 'Ensure valid task-manifest.json exists in the artifact store.',
                  artifacts: [],
                  detectedAt: now(),
                };
                const phase: Phase = {
                  id: this.phaseId(currentRun.uuid, firstIncompletePhase),
                  runUuid: currentRun.uuid,
                  name: firstIncompletePhase as string,
                  status: 'needs_human_review',
                  attempt: 1,
                  startedAt: now(),
                  completedAt: now(),
                };
                return this.needsHumanReviewRun(
                  currentRun,
                  firstIncompleteDef,
                  phase,
                  failure,
                  now(),
                  phases,
                );
              }

              const manifest = manifestResult.manifest as Record<string, unknown>;
              const tasks = Array.isArray(manifest.tasks) ? manifest.tasks : [];
              const task = tasks.find((t: unknown) => {
                if (!t || typeof t !== 'object') return false;
                const rec = t as Record<string, unknown>;
                return rec.n === resumableStep.index || rec.task_number === resumableStep.index;
              }) as Record<string, unknown> | undefined;

              if (!task) {
                const failureMessage = `cannot preserve working tree: task ${resumableStep.index} not found in manifest`;
                const failure: Failure = {
                  runUuid: currentRun.uuid,
                  phase: firstIncompletePhase as string,
                  kind: 'setup_failed',
                  message: failureMessage,
                  canRetry: true,
                  suggestedAction: 'Inspect task-manifest.json.',
                  artifacts: [],
                  detectedAt: now(),
                };
                const phase: Phase = {
                  id: this.phaseId(currentRun.uuid, firstIncompletePhase),
                  runUuid: currentRun.uuid,
                  name: firstIncompletePhase as string,
                  status: 'needs_human_review',
                  attempt: 1,
                  startedAt: now(),
                  completedAt: now(),
                };
                return this.needsHumanReviewRun(
                  currentRun,
                  firstIncompleteDef,
                  phase,
                  failure,
                  now(),
                  phases,
                );
              }

              const untrackedSet = new Set(
                statusOutput
                  .split('\n')
                  .filter(isUntrackedOrAddedStatusLine)
                  .map((line) => unquoteGitPath(line.slice(3).trim()).replace(/\\/g, '/'))
                  .map(normalizeTaskPath)
                  .filter(Boolean),
              );

              const dirtySourcePaths = uncommittedSourcePaths(statusOutput)
                .map(normalizeTaskPath)
                .filter(Boolean);

              const candidates: TaskChangeCandidate[] = dirtySourcePaths.map((p) => ({
                path: p,
                tracked: !untrackedSet.has(p),
              }));

              const currentScope = resolveEffectiveTaskScope(task);
              const classification = classifyTaskChanges({
                candidates,
                currentScope,
                manifest,
                currentTaskNumber: resumableStep.index,
              });

              const unapprovedPaths = [
                ...new Set([
                  ...classification.modifiedReferenceFiles,
                  ...classification.nonGoalFiles,
                  ...classification.prematureImplementation.map((p) => p.path),
                  ...classification.driftFiles,
                  ...(classification.protectedFiles ?? []),
                ]),
              ].sort();

              if (unapprovedPaths.length > 0) {
                const failureMessage = `preserve mode rejected unpermitted dirty paths in worktree: ${unapprovedPaths.join(', ')}`;
                const failure: Failure = {
                  runUuid: currentRun.uuid,
                  phase: firstIncompletePhase as string,
                  kind: 'setup_failed',
                  message: failureMessage,
                  canRetry: true,
                  suggestedAction: 'Clean or revert unpermitted dirty files before resuming.',
                  artifacts: [],
                  detectedAt: now(),
                };
                const phase: Phase = {
                  id: this.phaseId(currentRun.uuid, firstIncompletePhase),
                  runUuid: currentRun.uuid,
                  name: firstIncompletePhase as string,
                  status: 'needs_human_review',
                  attempt: 1,
                  startedAt: now(),
                  completedAt: now(),
                };
                return this.needsHumanReviewRun(
                  currentRun,
                  firstIncompleteDef,
                  phase,
                  failure,
                  now(),
                  phases,
                );
              }

              approvedInboundPaths = [...classification.permittedPaths].sort();
            }
          }
        } else if (isImplementPhase) {
          // Fresh implement phase — there is no in-progress step for
          // resumeDisposition (reset_to_baseline / preserve_working_tree) to
          // apply to, so it cannot be honored here. Do NOT fall through to the
          // strict non-implement cleanliness check below: that check rejects
          // ANY dirty path, including ambient residue left behind by a prior
          // plan-review phase, which ImplementHandler's own inbound audit
          // (checkInboundWorktreeCleanliness) is specifically designed to
          // detect, audit, and reset. Record that the requested disposition
          // was not applicable so it is not silently dropped, then let the
          // phase loop proceed into ImplementHandler's audited cleanup.
          const deferredMessage = `resumeDisposition '${input.resumeDisposition}' requested but no resumable implement step was found; deferring worktree cleanliness to the implement phase's own inbound audit`;
          const deferredMetadata = { resumeDisposition: input.resumeDisposition };
          try {
            this.deps.eventRepository?.insert({
              runUuid: currentRun.uuid,
              phase: firstIncompletePhase as string,
              level: 'info',
              type: 'run.resume_disposition_deferred',
              message: deferredMessage,
              metadata: deferredMetadata,
              timestamp: now(),
            });
          } catch (err) {
            this.deps.logger?.debug(
              'failed to insert resume_disposition_deferred audit event',
              err instanceof Error ? err.message : String(err),
            );
          }
          this.emit(
            run.displayId,
            run.uuid,
            firstIncompletePhase as string,
            'info',
            'run.resume_disposition_deferred',
            deferredMessage,
            now(),
            deferredMetadata,
          );
        } else {
          // No implementation worktree state to recover (non-implement phase)
          let dirtyPaths: string[] = [];
          if (this.deps.worktreeLifecycle) {
            try {
              const plan = await this.deps.worktreeLifecycle.inspect({
                cwd: ctxForResume.cwd,
                mode: 'phase_boundary',
                preservedPatterns: orchestratorExcludePatterns(),
              });
              dirtyPaths = plan.discardedPaths;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const lowerMsg = msg.toLowerCase();
              if (
                lowerMsg.includes('enoent') ||
                lowerMsg.includes('no such file or directory') ||
                lowerMsg.includes('does not exist') ||
                lowerMsg.includes('not a git repository') ||
                lowerMsg.includes('git not found on path') ||
                lowerMsg.includes('cannot change to') ||
                lowerMsg.includes('fatal: path')
              ) {
                dirtyPaths = [];
              } else {
                const failureMessage = `failed to check worktree cleanliness for resume: ${msg}`;
                const failure: Failure = {
                  runUuid: currentRun.uuid,
                  phase: firstIncompletePhase as string,
                  kind: 'setup_failed',
                  message: failureMessage,
                  canRetry: true,
                  suggestedAction: 'Inspect git repository accessibility.',
                  artifacts: [],
                  detectedAt: now(),
                };
                const phase: Phase = {
                  id: this.phaseId(currentRun.uuid, firstIncompletePhase),
                  runUuid: currentRun.uuid,
                  name: firstIncompletePhase as string,
                  status: 'needs_human_review',
                  attempt: 1,
                  startedAt: now(),
                  completedAt: now(),
                };
                return this.needsHumanReviewRun(
                  currentRun,
                  firstIncompleteDef,
                  phase,
                  failure,
                  now(),
                  phases,
                );
              }
            }
          } else {
            let statusOutput = '';
            try {
              statusOutput = await ctxForResume.git.status(ctxForResume.cwd);
              dirtyPaths = uncommittedSourcePaths(statusOutput);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const lowerMsg = msg.toLowerCase();
              if (
                lowerMsg.includes('enoent') ||
                lowerMsg.includes('no such file or directory') ||
                lowerMsg.includes('does not exist') ||
                lowerMsg.includes('not a git repository') ||
                lowerMsg.includes('git not found on path') ||
                lowerMsg.includes('cannot change to') ||
                lowerMsg.includes('fatal: path')
              ) {
                dirtyPaths = [];
              } else {
                const failureMessage = `failed to check git status for resume: ${msg}`;
                const failure: Failure = {
                  runUuid: currentRun.uuid,
                  phase: firstIncompletePhase as string,
                  kind: 'setup_failed',
                  message: failureMessage,
                  canRetry: true,
                  suggestedAction: 'Inspect git repository accessibility.',
                  artifacts: [],
                  detectedAt: now(),
                };
                const phase: Phase = {
                  id: this.phaseId(currentRun.uuid, firstIncompletePhase),
                  runUuid: currentRun.uuid,
                  name: firstIncompletePhase as string,
                  status: 'needs_human_review',
                  attempt: 1,
                  startedAt: now(),
                  completedAt: now(),
                };
                return this.needsHumanReviewRun(
                  currentRun,
                  firstIncompleteDef,
                  phase,
                  failure,
                  now(),
                  phases,
                );
              }
            }
          }

          if (dirtyPaths.length > 0) {
            const failureMessage = `cannot resume non-implement phase '${firstIncompletePhase}' with dirty worktree without an authoritative step baseline: ${dirtyPaths.join(', ')}`;
            const failure: Failure = {
              runUuid: currentRun.uuid,
              phase: firstIncompletePhase as string,
              kind: 'setup_failed',
              message: failureMessage,
              canRetry: true,
              suggestedAction: 'Clean the worktree before resuming.',
              artifacts: [],
              detectedAt: now(),
            };
            const phase: Phase = {
              id: this.phaseId(currentRun.uuid, firstIncompletePhase),
              runUuid: currentRun.uuid,
              name: firstIncompletePhase as string,
              status: 'needs_human_review',
              attempt: 1,
              startedAt: now(),
              completedAt: now(),
            };
            return this.needsHumanReviewRun(
              currentRun,
              firstIncompleteDef,
              phase,
              failure,
              now(),
              phases,
            );
          }
        }
      }
    }

    const ctx = this.buildContext(run, approvedInboundPaths);
    // When resuming, the worktree may have been cleaned or artifacts lost
    // (e.g. CancelRun runs git clean). Re-materialize durable artifacts
    // into the worktree before starting the phase loop.
    try {
      await ctx.artifacts.hydrateWorktree(run.uuid);
    } catch (err) {
      this.emit(
        run.displayId,
        run.uuid,
        undefined,
        'error',
        'run.worktree_hydration_failed',
        `failed to hydrate worktree from durable artifacts: ${err instanceof Error ? err.message : String(err)}`,
        now(),
      );
      return this.failOnWorktreeHydrationFailure(currentRun, err, now(), phases);
    }

    // When resuming with completedPhases, verify that declared outputs
    // actually exist in the artifact store.  If they are missing (crash,
    // manual cleanup, data corruption) we fail fast with a clear mismatch
    // error instead of trustingly accumulating the path into
    // presentArtifacts and letting a downstream handler hit an
    // ArtifactNotFoundError with a confusing message.
    let storedArtifacts: Set<string> | undefined;
    if (completedSet.size > 0) {
      try {
        const stored = await ctx.artifacts.list(run.uuid);
        storedArtifacts = new Set(stored.map((a) => a.relativePath));
      } catch {
        // non-fatal — proceed with declared outputs only
      }
    }

    const executionState: ExecutionState = {
      currentRun,
      skipSet,
      completedSet,
      previouslySkippedSet,
      presentArtifacts,
      storedArtifacts,
      phases,
      approvedInboundPaths,
      now,
    };

    const isLean =
      currentRun.executionPolicy === 'standard' || currentRun.executionPolicy === 'strict';
    if (isLean) {
      return this.executeLean(input, executionState);
    }
    return this.executeLegacy(input, executionState);
  }

  private async executeLegacy(
    input: ExecuteRunInput,
    state: ExecutionState,
  ): Promise<ExecuteRunOutput> {
    const { run } = input;
    const { now, phases } = state;

    for (const phaseName of CANONICAL_PHASE_ORDER) {
      const step = await this.executeSinglePhase(phaseName, run, state);
      if (step.status === 'terminal') {
        return step.terminalResult!;
      }
    }

    const cancelledFinal = this.deps.runRepository.findByUuid(run.uuid);
    if (
      cancelledFinal &&
      ['cancelled', 'failed', 'blocked', 'passed'].includes(cancelledFinal.status)
    ) {
      return { run: cancelledFinal, phases };
    }

    return this.passRun(state.currentRun, now, phases);
  }

  private async executeLean(
    input: ExecuteRunInput,
    state: ExecutionState,
  ): Promise<ExecuteRunOutput> {
    const { run } = input;
    const { now, phases } = state;
    const definitions = PHASE_DEFINITIONS;

    // Seed presentArtifacts with outputs of all already-completed phases
    for (const completedPhase of state.completedSet) {
      const def = definitions[completedPhase as PhaseName];
      if (def) {
        for (const out of def.outputs) {
          if (!state.presentArtifacts.includes(out)) {
            state.presentArtifacts.push(out);
          }
        }
      }
      if (completedPhase === 'plan-design') {
        if (!state.presentArtifacts.includes('plan.md')) {
          state.presentArtifacts.push('plan.md');
        }
      }
    }

    // 1. read_issue
    if (!state.completedSet.has('read_issue')) {
      const step = await this.executeSinglePhase(PhaseName('read_issue'), run, state);
      if (step.status === 'terminal') return step.terminalResult!;
    }

    // 2. plan-design (unified planning)
    if (!state.completedSet.has('plan-design')) {
      const step = await this.executeSinglePhase(PhaseName('plan-design'), run, state);
      if (step.status === 'terminal') return step.terminalResult!;
    }

    // 3. implement
    if (!state.completedSet.has('implement')) {
      const step = await this.executeSinglePhase(PhaseName('implement'), run, state);
      if (step.status === 'terminal') return step.terminalResult!;
    }

    // 4. validate (deterministic validation)
    if (!state.completedSet.has('validate')) {
      const step = await this.executeSinglePhase(PhaseName('validate'), run, state);
      if (step.status === 'terminal') return step.terminalResult!;

      if (step.status === 'deferred') {
        // Validation deferred / failed -> Bounded 1-attempt repair via fix-validate
        const fixStep = await this.executeSinglePhase(PhaseName('fix-validate'), run, state, {
          forceRun: true,
        });
        if (fixStep.status === 'terminal') return fixStep.terminalResult!;
        if (fixStep.status !== 'passed') {
          return this.escalateToHumanReview(
            state.currentRun,
            PhaseName('fix-validate'),
            'fix-validate repair attempt did not pass',
            now(),
            phases,
          );
        }

        // Full deterministic revalidation
        const revalStep = await this.executeSinglePhase(PhaseName('validate'), run, state, {
          forceRun: true,
        });
        if (revalStep.status === 'terminal') return revalStep.terminalResult!;
        if (revalStep.status !== 'passed') {
          return this.escalateToHumanReview(
            state.currentRun,
            PhaseName('validate'),
            'deterministic revalidation failed after fix-validate repair attempt',
            now(),
            phases,
          );
        }
      }
    }

    // 5. Review & Convergence (#1107 Coordination)
    const prAlreadyCompleted =
      state.completedSet.has('create-pr') || state.completedSet.has('wait-merge');
    if (!prAlreadyCompleted) {
      const initialReviewName = PhaseName('initial-review');
      const ctx = this.buildContext(state.currentRun, state.approvedInboundPaths);
      const maxReviewFixIterations =
        input.reviewConvergenceMaxIterations ?? this.deps.reviewConvergenceMaxIterations ?? 4;

      interface LeanReviewConvergenceState {
        iteration: number;
        subStep: 'fix-review' | 'validate' | 'follow-up-review' | 'approved';
        verdict: 'APPROVE' | 'REQUEST_CHANGES';
      }

      let convergenceState: LeanReviewConvergenceState | undefined;
      try {
        const rawConv = await ctx.artifacts.read(run.uuid, 'review-convergence.json');
        convergenceState = JSON.parse(rawConv) as LeanReviewConvergenceState;
      } catch {
        convergenceState = undefined;
      }

      // If initial-review is not yet recorded as completed and no convergence state exists
      if (!state.completedSet.has('initial-review') && !convergenceState) {
        const step = await this.executeSinglePhase(initialReviewName, run, state);
        if (step.status === 'terminal') return step.terminalResult!;

        let initialVerdict: 'APPROVE' | 'REQUEST_CHANGES' = 'REQUEST_CHANGES';
        try {
          const wholeChangeResult = await ctx.artifacts.read(run.uuid, 'whole-change-review.json');
          const parsed = JSON.parse(wholeChangeResult) as { verdict?: string };
          initialVerdict =
            parsed.verdict?.toUpperCase() === 'APPROVE' ? 'APPROVE' : 'REQUEST_CHANGES';
        } catch {
          // If whole-change-review.json is missing or corrupted, check ledger
          try {
            const ledgerRaw = await ctx.artifacts.read(run.uuid, 'finding-ledger.json');
            const ledger = JSON.parse(ledgerRaw) as { entries?: Array<{ status?: string }> };
            const hasUnresolved = ledger.entries?.some((e) => e.status === 'unresolved');
            initialVerdict = hasUnresolved ? 'REQUEST_CHANGES' : 'APPROVE';
          } catch (ledgerErr) {
            return this.escalateToHumanReview(
              state.currentRun,
              initialReviewName,
              `Missing or unreadable review artifacts after initial-review: ${ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr)}`,
              now(),
              phases,
            );
          }
        }

        if (initialVerdict === 'APPROVE') {
          convergenceState = { iteration: 0, subStep: 'approved', verdict: 'APPROVE' };
          await ctx.artifacts.write({
            runId: run.uuid,
            phaseId: initialReviewName,
            relativePath: 'review-convergence.json',
            contents: JSON.stringify(convergenceState, null, 2),
          });
        } else {
          convergenceState = { iteration: 1, subStep: 'fix-review', verdict: 'REQUEST_CHANGES' };
          await ctx.artifacts.write({
            runId: run.uuid,
            phaseId: initialReviewName,
            relativePath: 'review-convergence.json',
            contents: JSON.stringify(convergenceState, null, 2),
          });
        }
      }

      // Review-Fix Convergence Loop (persisted step-by-step for safe resume)
      if (convergenceState && convergenceState.subStep !== 'approved') {
        while (
          convergenceState.subStep !== 'approved' &&
          convergenceState.iteration <= maxReviewFixIterations
        ) {
          // Sub-step A: fix-review
          if (convergenceState.subStep === 'fix-review') {
            const fixReviewName = PhaseName('fix-review');
            const fixStep = await this.executeSinglePhase(fixReviewName, run, state, {
              forceRun: true,
            });
            if (fixStep.status === 'terminal') return fixStep.terminalResult!;

            convergenceState = {
              iteration: convergenceState.iteration,
              subStep: 'validate',
              verdict: 'REQUEST_CHANGES',
            };
            await ctx.artifacts.write({
              runId: run.uuid,
              phaseId: fixReviewName,
              relativePath: 'review-convergence.json',
              contents: JSON.stringify(convergenceState, null, 2),
            });
          }

          // Sub-step B: deterministic validate after fix
          if (convergenceState.subStep === 'validate') {
            const valStep = await this.executeSinglePhase(PhaseName('validate'), run, state, {
              forceRun: true,
            });
            if (valStep.status === 'terminal') return valStep.terminalResult!;
            if (valStep.status === 'deferred') {
              // Bounded 1-attempt repair via fix-validate
              const fixValStep = await this.executeSinglePhase(
                PhaseName('fix-validate'),
                run,
                state,
                { forceRun: true },
              );
              if (fixValStep.status === 'terminal') return fixValStep.terminalResult!;
              if (fixValStep.status !== 'passed') {
                return this.escalateToHumanReview(
                  state.currentRun,
                  PhaseName('fix-validate'),
                  'validation repair failed after review fix',
                  now(),
                  phases,
                );
              }
              const revalStep = await this.executeSinglePhase(PhaseName('validate'), run, state, {
                forceRun: true,
              });
              if (revalStep.status === 'terminal') return revalStep.terminalResult!;
              if (revalStep.status !== 'passed') {
                return this.escalateToHumanReview(
                  state.currentRun,
                  PhaseName('validate'),
                  'revalidation failed after review fix repair',
                  now(),
                  phases,
                );
              }
            }

            convergenceState = {
              iteration: convergenceState.iteration,
              subStep: 'follow-up-review',
              verdict: 'REQUEST_CHANGES',
            };
            await ctx.artifacts.write({
              runId: run.uuid,
              phaseId: PhaseName('validate'),
              relativePath: 'review-convergence.json',
              contents: JSON.stringify(convergenceState, null, 2),
            });
          }

          // Sub-step C: follow-up-review
          if (convergenceState.subStep === 'follow-up-review') {
            const followUpName = PhaseName('follow-up-review');
            const follStep = await this.executeSinglePhase(followUpName, run, state, {
              forceRun: true,
            });
            if (follStep.status === 'terminal') return follStep.terminalResult!;

            let followUpVerdict: 'APPROVE' | 'REQUEST_CHANGES' = 'REQUEST_CHANGES';
            try {
              const followUpRaw = await ctx.artifacts.read(run.uuid, 'follow-up-review.json');
              const parsed = JSON.parse(followUpRaw) as { verdict?: string };
              followUpVerdict =
                parsed.verdict?.toUpperCase() === 'APPROVE' ? 'APPROVE' : 'REQUEST_CHANGES';
            } catch {
              try {
                const ledgerRaw = await ctx.artifacts.read(run.uuid, 'finding-ledger.json');
                const ledger = JSON.parse(ledgerRaw) as { entries?: Array<{ status?: string }> };
                const hasUnresolved = ledger.entries?.some((e) => e.status === 'unresolved');
                followUpVerdict = hasUnresolved ? 'REQUEST_CHANGES' : 'APPROVE';
              } catch (ledgerErr) {
                return this.escalateToHumanReview(
                  state.currentRun,
                  followUpName,
                  `Missing or unreadable review artifacts after follow-up-review: ${ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr)}`,
                  now(),
                  phases,
                );
              }
            }

            if (followUpVerdict === 'APPROVE') {
              convergenceState = {
                iteration: convergenceState.iteration,
                subStep: 'approved',
                verdict: 'APPROVE',
              };
              await ctx.artifacts.write({
                runId: run.uuid,
                phaseId: followUpName,
                relativePath: 'review-convergence.json',
                contents: JSON.stringify(convergenceState, null, 2),
              });
              break;
            }

            if (convergenceState.iteration >= maxReviewFixIterations) {
              return this.escalateToHumanReview(
                state.currentRun,
                followUpName,
                `review-fix convergence loop exhausted after ${maxReviewFixIterations} iterations without approval`,
                now(),
                phases,
              );
            }

            convergenceState = {
              iteration: convergenceState.iteration + 1,
              subStep: 'fix-review',
              verdict: 'REQUEST_CHANGES',
            };
            await ctx.artifacts.write({
              runId: run.uuid,
              phaseId: followUpName,
              relativePath: 'review-convergence.json',
              contents: JSON.stringify(convergenceState, null, 2),
            });
          }
        }
      }
    }

    // 6. create-pr
    if (!state.completedSet.has('create-pr')) {
      const step = await this.executeSinglePhase(PhaseName('create-pr'), run, state);
      if (step.status === 'terminal') return step.terminalResult!;
    }

    // 7. wait-merge (terminal CI / merge waiting, strictly wait-merge)
    if (!state.completedSet.has('wait-merge')) {
      const step = await this.executeSinglePhase(PhaseName('wait-merge'), run, state);
      if (step.status === 'terminal') return step.terminalResult!;
    }

    // 8. Terminal success
    const cancelledFinal = this.deps.runRepository.findByUuid(run.uuid);
    if (
      cancelledFinal &&
      ['cancelled', 'failed', 'blocked', 'passed'].includes(cancelledFinal.status)
    ) {
      return { run: cancelledFinal, phases };
    }

    return this.passRun(state.currentRun, now, phases);
  }

  private async executeSinglePhase(
    phaseName: PhaseName,
    run: Run,
    state: ExecutionState,
    opts?: { forceRun?: boolean },
  ): Promise<{
    status: PhaseStatus | 'terminal';
    terminalResult?: ExecuteRunOutput;
  }> {
    const {
      now,
      skipSet,
      completedSet,
      previouslySkippedSet,
      presentArtifacts,
      storedArtifacts,
      phases,
    } = state;
    const phaseDef = PHASE_DEFINITIONS[phaseName] ?? getPhaseDefinition(phaseName);

    if (
      !opts?.forceRun &&
      completedSet.has(phaseName as string) &&
      !previouslySkippedSet.has(phaseName as string)
    ) {
      for (const output of phaseDef.outputs) {
        if (storedArtifacts && !storedArtifacts.has(output)) {
          const terminalResult = this.failOnResumeArtifactMismatch(
            state.currentRun,
            phaseDef,
            output,
            now(),
            phases,
          );
          return { status: 'terminal', terminalResult };
        }
        if (!presentArtifacts.includes(output)) {
          presentArtifacts.push(output);
        }
      }
      phases.push({ phase: phaseName, status: 'passed' });
      return { status: 'passed' };
    }

    if (!opts?.forceRun && previouslySkippedSet.has(phaseName as string)) {
      phases.push({ phase: phaseName, status: 'skipped' });
      return { status: 'skipped' };
    }

    if (skipSet.has(phaseName as string)) {
      state.currentRun = {
        ...state.currentRun,
        skippedPhases: [...state.currentRun.skippedPhases, phaseName as string],
      };
      const phase: Phase = {
        id: this.phaseId(run.uuid, phaseName),
        runUuid: run.uuid,
        name: phaseName as string,
        status: 'skipped',
        attempt: 1,
        startedAt: now(),
        completedAt: now(),
      };
      this.deps.phaseRepository.insert(phase);
      this.deps.runRepository.update(run.uuid, {
        skippedPhases: state.currentRun.skippedPhases,
      });
      phases.push({ phase: phaseName, status: 'skipped' });
      this.emit(
        run.displayId,
        run.uuid,
        phaseName as string,
        'info',
        'phase.skipped',
        `phase '${String(phaseName)}' skipped`,
        now(),
      );
      return { status: 'skipped' };
    }

    const handler = this.deps.registry.get(phaseDef.name);

    // Input gating
    try {
      assertInputsAvailable(phaseDef, presentArtifacts);
    } catch (e) {
      if (e instanceof MissingRequiredInputError) {
        const terminalResult = this.failOnMissingInput(
          state.currentRun,
          phaseDef,
          e,
          now(),
          phases,
        );
        return { status: 'terminal', terminalResult };
      }
      throw e;
    }

    // Transition: start phase
    state.currentRun = startPhase(state.currentRun, phaseDef.name as string);

    const existingPhases = this.deps.phaseRepository.listByRun(run.uuid);
    const existingPhase = existingPhases.find((p) => p.name === phaseDef.name);
    const phase: Phase = {
      id: this.phaseId(run.uuid, phaseDef.name),
      runUuid: run.uuid,
      name: phaseDef.name as string,
      status: 'running',
      attempt: existingPhase ? existingPhase.attempt + 1 : 1,
      startedAt: now(),
    };
    this.deps.phaseRepository.insert(phase);
    this.deps.runRepository.update(run.uuid, { currentPhase: phaseDef.name as string });
    this.emit(
      run.displayId,
      run.uuid,
      phaseDef.name as string,
      'info',
      'phase.started',
      `starting phase '${String(phaseDef.name)}'`,
      now(),
    );

    const cancelled = this.deps.runRepository.findByUuid(run.uuid);
    if (
      cancelled &&
      ['cancelled', 'failed', 'blocked', 'needs_human_review', 'passed'].includes(cancelled.status)
    ) {
      return { status: 'terminal', terminalResult: { run: cancelled, phases } };
    }

    const ctx = this.buildContext(state.currentRun, state.approvedInboundPaths);
    let result: PhaseResult;
    try {
      result = await handler.run(ctx);
    } catch (err) {
      const cancelledNow = this.deps.runRepository.findByUuid(run.uuid);
      if (
        cancelledNow &&
        ['cancelled', 'failed', 'blocked', 'passed'].includes(cancelledNow.status)
      ) {
        return { status: 'terminal', terminalResult: { run: cancelledNow, phases } };
      }
      if (err instanceof HandlerNotWiredError) {
        const failure: Failure = {
          runUuid: state.currentRun.uuid,
          phase: phaseDef.name as string,
          kind: 'handler_not_wired',
          message: err.message,
          canRetry: false,
          suggestedAction: `Phase handler for "${phaseDef.name}" is not wired. Register a real PhaseHandler implementation before invoking RunExecutor.`,
          artifacts: [],
          detectedAt: now(),
        };
        const terminalResult = this.blockRun(
          state.currentRun,
          phaseDef,
          phase,
          failure,
          now(),
          phases,
        );
        return { status: 'terminal', terminalResult };
      }
      const failure: Failure = {
        runUuid: state.currentRun.uuid,
        phase: phaseDef.name as string,
        kind: 'command_failed',
        message: err instanceof Error ? err.message : String(err),
        canRetry: false,
        suggestedAction: 'Inspect handler execution error.',
        artifacts: [],
        detectedAt: now(),
      };
      const terminalResult = this.failRun(
        state.currentRun,
        phaseDef,
        phase,
        failure,
        now(),
        phases,
      );
      return { status: 'terminal', terminalResult };
    }

    const cancelledAfterHandler = this.deps.runRepository.findByUuid(run.uuid);
    if (
      cancelledAfterHandler &&
      ['cancelled', 'failed', 'blocked', 'passed'].includes(cancelledAfterHandler.status) &&
      result.outcome !== 'resting'
    ) {
      return { status: 'terminal', terminalResult: { run: cancelledAfterHandler, phases } };
    }

    switch (result.outcome) {
      case 'deferred':
      case 'passed': {
        const status = result.outcome as 'deferred' | 'passed';
        state.currentRun = completePhase(state.currentRun, phaseDef.name as string);
        phase.status = status;
        phase.completedAt = now();
        for (const output of phaseDef.outputs) {
          if (!presentArtifacts.includes(output)) {
            presentArtifacts.push(output);
          }
        }
        try {
          const stored = await ctx.artifacts.list(run.uuid);
          for (const a of stored) {
            if (!presentArtifacts.includes(a.relativePath)) {
              presentArtifacts.push(a.relativePath);
            }
          }
        } catch {
          // non-fatal
        }
        this.deps.phaseRepository.update(phase);
        this.deps.runRepository.update(run.uuid, {
          currentPhase: null,
          completedPhases: state.currentRun.completedPhases,
        });
        const eventMsg =
          status === 'deferred'
            ? `phase '${String(phaseDef.name)}' deferred — pipeline continues`
            : `phase '${String(phaseDef.name)}' completed`;
        phases.push({ phase: phaseDef.name, status });
        this.emit(
          run.displayId,
          run.uuid,
          phaseDef.name as string,
          'info',
          'phase.completed',
          eventMsg,
          now(),
        );
        return { status };
      }
      case 'skipped': {
        state.currentRun = skipPhase(state.currentRun, phaseDef.name as string);
        phase.status = 'skipped';
        phase.completedAt = now();
        try {
          const stored = await ctx.artifacts.list(run.uuid);
          for (const a of stored) {
            if (!presentArtifacts.includes(a.relativePath)) {
              presentArtifacts.push(a.relativePath);
            }
          }
        } catch {
          // non-fatal
        }
        this.deps.phaseRepository.update(phase);
        this.deps.runRepository.update(run.uuid, {
          currentPhase: null,
          skippedPhases: state.currentRun.skippedPhases,
        });
        phases.push({ phase: phaseDef.name, status: 'skipped' });
        this.emit(
          run.displayId,
          run.uuid,
          phaseDef.name as string,
          'info',
          'phase.skipped',
          `phase '${String(phaseDef.name)}' skipped by handler`,
          now(),
        );
        return { status: 'skipped' };
      }
      case 'resting': {
        phase.status = 'resting';
        phase.completedAt = now();
        this.deps.phaseRepository.update(phase);
        const restingRun = { ...state.currentRun };
        delete restingRun.currentPhase;
        this.deps.runRepository.update(run.uuid, { currentPhase: null });
        phases.push({ phase: phaseDef.name, status: 'resting' });
        this.emit(
          run.displayId,
          run.uuid,
          phaseDef.name as string,
          'info',
          'phase.resting',
          `phase '${String(phaseDef.name)}' resting — run paused`,
          now(),
        );
        return { status: 'terminal', terminalResult: { run: restingRun, phases } };
      }
      case 'failed': {
        const terminalResult = this.failRun(
          state.currentRun,
          phaseDef,
          phase,
          result.failure,
          now(),
          phases,
        );
        return { status: 'terminal', terminalResult };
      }
      case 'blocked': {
        const terminalResult = this.blockRun(
          state.currentRun,
          phaseDef,
          phase,
          result.failure,
          now(),
          phases,
        );
        return { status: 'terminal', terminalResult };
      }
      case 'needs_human_review': {
        const terminalResult = this.needsHumanReviewRun(
          state.currentRun,
          phaseDef,
          phase,
          result.failure,
          now(),
          phases,
        );
        return { status: 'terminal', terminalResult };
      }
    }
  }

  private escalateToHumanReview(
    currentRun: Run,
    phaseName: PhaseName,
    message: string,
    now: Date,
    phases: PhaseRecord[],
  ): ExecuteRunOutput {
    const phaseDef = PHASE_DEFINITIONS[phaseName] ?? getPhaseDefinition(phaseName);
    const phase: Phase = {
      id: this.phaseId(currentRun.uuid, phaseName),
      runUuid: currentRun.uuid,
      name: phaseName as string,
      status: 'needs_human_review',
      attempt: 1,
      startedAt: now,
      completedAt: now,
    };
    const failure: Failure = {
      runUuid: currentRun.uuid,
      phase: phaseName as string,
      kind: 'needs_human_review',
      message,
      canRetry: true,
      suggestedAction: 'Review the run artifacts, address unresolved issues, and resume.',
      artifacts: [],
      detectedAt: now,
    };
    return this.needsHumanReviewRun(currentRun, phaseDef, phase, failure, now, phases);
  }

  private passRun(currentRun: Run, now: () => Date, phases: PhaseRecord[]): ExecuteRunOutput {
    const finalRun = passRun(currentRun, now());
    this.terminalStatusWrite(currentRun.uuid, 'passed', {
      status: 'passed',
      currentPhase: null,
      completedAt: now(),
      failureReason: null,
    });
    this.emit(
      currentRun.displayId,
      currentRun.uuid,
      undefined,
      'info',
      'run.completed',
      'all phases completed successfully',
      now(),
    );
    return { run: finalRun, phases };
  }

  private failRun(
    currentRun: Run,
    phaseDef: PhaseDefinition,
    phase: Phase,
    failure: Failure,
    at: Date,
    phases: PhaseRecord[],
  ): ExecuteRunOutput {
    // Safety net: if the run was externally set to a terminal state, don't overwrite it
    const cancelled = this.deps.runRepository.findByUuid(currentRun.uuid);
    if (cancelled && ['cancelled', 'failed', 'blocked', 'passed'].includes(cancelled.status)) {
      return { run: cancelled, phases };
    }

    if (failure.runUuid !== currentRun.uuid) {
      throw new Error(
        `handler returned failure with mismatched runUuid: expected ${currentRun.uuid}, got ${failure.runUuid}`,
      );
    }
    const run = failRun(currentRun, failure.message, at);
    phase.status = 'failed';
    phase.completedAt = at;
    if (phase.startedAt) {
      this.deps.phaseRepository.update(phase);
    } else {
      this.deps.phaseRepository.insert(phase);
    }
    this.deps.failureRepository.insert(failure);
    this.terminalStatusWrite(
      run.uuid,
      'failed',
      {
        status: 'failed',
        currentPhase: null,
        completedAt: at,
        failureReason: failure.message,
      },
      phaseDef.name as string,
    );
    phases.push({ phase: phaseDef.name, status: 'failed', failure });
    this.emit(
      run.displayId,
      run.uuid,
      phaseDef.name as string,
      'error',
      'phase.failed',
      failure.message,
      at,
    );
    this.emit(
      run.displayId,
      run.uuid,
      undefined,
      'error',
      'run.failed',
      `run failed at phase '${String(phaseDef.name)}'`,
      at,
    );
    return { run, phases };
  }

  private blockRun(
    currentRun: Run,
    phaseDef: PhaseDefinition,
    phase: Phase,
    failure: Failure,
    at: Date,
    phases: PhaseRecord[],
  ): ExecuteRunOutput {
    // Safety net: if the run was externally set to a terminal state, don't overwrite it
    const cancelled = this.deps.runRepository.findByUuid(currentRun.uuid);
    if (cancelled && ['cancelled', 'failed', 'blocked', 'passed'].includes(cancelled.status)) {
      return { run: cancelled, phases };
    }

    if (failure.runUuid !== currentRun.uuid) {
      throw new Error(
        `handler returned failure with mismatched runUuid: expected ${currentRun.uuid}, got ${failure.runUuid}`,
      );
    }
    const run = blockRun(currentRun, failure.message, at);
    phase.status = 'blocked';
    phase.completedAt = at;
    this.deps.phaseRepository.update(phase);
    this.deps.failureRepository.insert(failure);
    this.terminalStatusWrite(
      run.uuid,
      'blocked',
      {
        status: 'blocked',
        currentPhase: null,
        completedAt: at,
        failureReason: failure.message,
      },
      phaseDef.name as string,
    );
    phases.push({ phase: phaseDef.name, status: 'blocked', failure });
    this.emit(
      run.displayId,
      run.uuid,
      phaseDef.name as string,
      'warn',
      'phase.blocked',
      failure.message,
      at,
    );
    this.emit(
      run.displayId,
      run.uuid,
      undefined,
      'warn',
      'run.blocked',
      `run blocked at phase '${String(phaseDef.name)}'`,
      at,
    );
    return { run, phases };
  }

  private buildContext(run: Run, approvedInboundPaths?: string[]): PhaseHandlerContext {
    const raw = this.deps.contextFactory(run);
    if (approvedInboundPaths !== undefined) {
      return {
        ...raw,
        approvedInboundPaths,
        inboundPreserveAllowance: approvedInboundPaths,
      };
    }
    return raw;
  }

  private needsHumanReviewRun(
    currentRun: Run,
    phaseDef: PhaseDefinition,
    phase: Phase,
    failure: Failure,
    at: Date,
    phases: PhaseRecord[],
  ): ExecuteRunOutput {
    const cancelled = this.deps.runRepository.findByUuid(currentRun.uuid);
    if (cancelled && ['cancelled', 'failed', 'blocked', 'passed'].includes(cancelled.status)) {
      return { run: cancelled, phases };
    }

    if (failure.runUuid !== currentRun.uuid) {
      throw new Error(
        `handler returned failure with mismatched runUuid: expected ${currentRun.uuid}, got ${failure.runUuid}`,
      );
    }
    const run = markRunNeedsHumanReview(currentRun, failure.message, at);
    phase.status = 'needs_human_review';
    phase.completedAt = at;
    const existingPhases = this.deps.phaseRepository.listByRun(currentRun.uuid);
    const existing = existingPhases.find((p) => p.name === phaseDef.name);
    if (existing) {
      this.deps.phaseRepository.update(phase);
    } else {
      this.deps.phaseRepository.insert(phase);
    }
    this.deps.failureRepository.insert(failure);
    this.terminalStatusWrite(
      run.uuid,
      'needs_human_review',
      {
        status: 'needs_human_review',
        currentPhase: run.currentPhase ?? null,
        completedAt: at,
        failureReason: failure.message,
      },
      phaseDef.name as string,
    );
    phases.push({ phase: phaseDef.name, status: 'needs_human_review', failure });
    this.emit(
      run.displayId,
      run.uuid,
      phaseDef.name as string,
      'warn',
      'phase.needs_human_review',
      failure.message,
      at,
    );
    this.emit(
      run.displayId,
      run.uuid,
      undefined,
      'warn',
      'run.needs_human_review',
      `run needs human review at phase '${String(phaseDef.name)}'`,
      at,
    );
    return { run, phases };
  }

  private failOnResumeArtifactMismatch(
    currentRun: Run,
    phaseDef: PhaseDefinition,
    missingArtifact: string,
    at: Date,
    phases: PhaseRecord[],
  ): ExecuteRunOutput {
    const msg = `phase '${String(phaseDef.name)}' completed per DB but its output '${missingArtifact}' is missing from the artifact store`;
    const failure: Failure = {
      runUuid: currentRun.uuid,
      phase: phaseDef.name as string,
      kind: 'missing_artifact',
      message: msg,
      canRetry: false,
      suggestedAction:
        `Artifact '${missingArtifact}' is declared as an output of phase '${String(phaseDef.name)}' ` +
        `but no longer exists in the store. Restore it from backup or reset the run to ` +
        `re-execute the phase.`,
      artifacts: [],
      detectedAt: at,
    };
    const phase: Phase = {
      id: this.phaseId(currentRun.uuid, phaseDef.name),
      runUuid: currentRun.uuid,
      name: phaseDef.name as string,
      status: 'failed',
      attempt: 1,
      startedAt: at,
      completedAt: at,
    };
    return this.failRun(currentRun, phaseDef, phase, failure, at, phases);
  }

  private failOnWorktreeHydrationFailure(
    currentRun: Run,
    error: unknown,
    at: Date,
    phases: PhaseRecord[],
  ): ExecuteRunOutput {
    const cancelled = this.deps.runRepository.findByUuid(currentRun.uuid);
    if (cancelled && ['cancelled', 'failed', 'blocked', 'passed'].includes(cancelled.status)) {
      return { run: cancelled, phases };
    }

    const message = `failed to hydrate worktree from durable artifacts: ${
      error instanceof Error ? error.message : String(error)
    }`;
    const failure: Failure = {
      runUuid: currentRun.uuid,
      kind: 'setup_failed',
      message,
      canRetry: true,
      suggestedAction: 'Restore durable artifact-store access, then retry the run.',
      artifacts: [],
      detectedAt: at,
    };
    const run = failRun(currentRun, failure.message, at);
    this.deps.failureRepository.insert(failure);
    this.terminalStatusWrite(run.uuid, 'failed', {
      status: 'failed',
      currentPhase: null,
      completedAt: at,
      failureReason: failure.message,
    });
    this.emit(run.displayId, run.uuid, undefined, 'error', 'run.failed', failure.message, at);
    return { run, phases };
  }

  private failOnMissingInput(
    currentRun: Run,
    phaseDef: PhaseDefinition,
    error: MissingRequiredInputError,
    at: Date,
    phases: PhaseRecord[],
  ): ExecuteRunOutput {
    const failure: Failure = {
      runUuid: currentRun.uuid,
      phase: phaseDef.name as string,
      kind: 'missing_artifact',
      message: error.message,
      canRetry: false,
      suggestedAction: `Verify that required artifacts (${error.missing.join(', ')}) are produced by earlier phases.`,
      artifacts: [],
      detectedAt: at,
    };
    const phase: Phase = {
      id: this.phaseId(currentRun.uuid, phaseDef.name),
      runUuid: currentRun.uuid,
      name: phaseDef.name as string,
      status: 'failed',
      attempt: 1,
      startedAt: at,
      completedAt: at,
    };
    return this.failRun(currentRun, phaseDef, phase, failure, at, phases);
  }

  private phaseId(runUuid: string, phaseName: PhaseName): string {
    return `${runUuid}-${String(phaseName)}`;
  }

  private terminalStatusWrite(
    runUuid: string,
    status: 'passed' | 'failed' | 'blocked' | 'needs_human_review',
    patch: {
      status: 'passed' | 'failed' | 'blocked' | 'needs_human_review';
      currentPhase?: string | null;
      completedAt: Date;
      failureReason?: string | null;
    },
    phase?: string,
  ): void {
    const operationName = `terminal status write`;
    this.deps.logger?.debug(
      `${operationName} starting`,
      `runUuid=${runUuid}`,
      `status=${status}`,
      phase !== undefined ? `phase=${phase}` : 'phase=final',
    );
    this.deps.runRepository.update(runUuid, patch);
    this.deps.logger?.debug(
      `${operationName} completed`,
      `runUuid=${runUuid}`,
      `status=${status}`,
      phase !== undefined ? `phase=${phase}` : 'phase=final',
    );
  }

  private emit(
    runId: string,
    runUuid: string,
    phase: string | undefined,
    level: 'info' | 'warn' | 'error',
    type: string,
    message: string,
    now: Date,
    metadata?: Record<string, unknown>,
  ): void {
    this.deps.events.publish(runUuid, {
      runId,
      ...(phase !== undefined ? { phase } : {}),
      level,
      type,
      message,
      timestamp: now.toISOString(),
      metadata: metadata ?? {},
    });
  }
}

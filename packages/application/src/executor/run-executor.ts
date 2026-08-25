import type {
  Run,
  Phase,
  PhaseName,
  PhaseStatus,
  Failure,
  ResumeDisposition,
  Step,
  RunId,
} from '@ai-sdlc/domain';
import {
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
  orderedPhases,
  assertInputsAvailable,
  MissingRequiredInputError,
} from '../phases/phase-definitions.js';
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
  type TaskChangeCandidate,
} from '../task-file-boundaries.js';

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
}

export interface ExecuteRunInput {
  run: Run;
  skip: PhaseName[];
  presentArtifacts: string[];
  resumeDisposition?: ResumeDisposition;
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
    orderedPhases(skip);

    const skipSet: Set<string> = new Set(skip.map((s) => s as string));
    const completedSet = new Set(currentRun.completedPhases);
    const previouslySkippedSet = new Set(currentRun.skippedPhases);

    let approvedInboundPaths: string[] | undefined;

    if (input.resumeDisposition !== undefined) {
      let firstIncompletePhase: PhaseName | undefined;
      for (const phaseName of CANONICAL_PHASE_ORDER) {
        if (
          !completedSet.has(phaseName as string) &&
          !previouslySkippedSet.has(phaseName as string) &&
          !skipSet.has(phaseName as string)
        ) {
          firstIncompletePhase = phaseName;
          break;
        }
      }

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

    // Main phase loop — iterate in canonical order. Skipped phases are
    // recorded at their natural position so persisted phase ordering
    // remains correct even when the run fails before reaching a skipped
    // phase. Completed phases (resume scenario) accumulate their outputs
    // so downstream input gating passes.
    for (const phaseName of CANONICAL_PHASE_ORDER) {
      const phaseDef = PHASE_DEFINITIONS[phaseName]!;

      // Phases that truly passed (were not skipped) accumulate declared
      // outputs so downstream input gating can rely on them.  When
      // storedArtifacts is available we verify each output against the
      // store first; a mismatch fails the run immediately.
      if (completedSet.has(phaseName as string) && !previouslySkippedSet.has(phaseName as string)) {
        for (const output of phaseDef.outputs) {
          if (storedArtifacts && !storedArtifacts.has(output)) {
            return this.failOnResumeArtifactMismatch(currentRun, phaseDef, output, now(), phases);
          }
          if (!presentArtifacts.includes(output)) {
            presentArtifacts.push(output);
          }
        }
        phases.push({ phase: phaseName, status: 'passed' });
        continue;
      }

      // Previously skipped phases are skipped again on resume but do NOT
      // accumulate declared outputs — the handler chose not to produce them.
      if (previouslySkippedSet.has(phaseName as string)) {
        phases.push({ phase: phaseName, status: 'skipped' });
        continue;
      }

      if (skipSet.has(phaseName as string)) {
        currentRun = {
          ...currentRun,
          skippedPhases: [...currentRun.skippedPhases, phaseName as string],
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
          skippedPhases: currentRun.skippedPhases,
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
        continue;
      }
      const handler = this.deps.registry.get(phaseDef.name);

      // Input gating
      try {
        assertInputsAvailable(phaseDef, presentArtifacts);
      } catch (e) {
        if (e instanceof MissingRequiredInputError) {
          return this.failOnMissingInput(currentRun, phaseDef, e, now(), phases);
        }
        throw e;
      }

      // Transition: start phase
      currentRun = startPhase(currentRun, phaseDef.name as string);

      const existingPhases = this.deps.phaseRepository.listByRun(run.uuid);
      const existingPhase = existingPhases.find((p) => p.name === phaseDef.name);
      const phase: Phase = {
        id: this.phaseId(run.uuid, phaseDef.name),
        runUuid: run.uuid,
        name: phaseDef.name as string,
        status: 'running',
        attempt: existingPhase?.attempt ?? 1,
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

      // Re-read persisted run state — run may have been cancelled during phase
      // start bookkeeping or a previous handler. If so, bail immediately instead
      // of writing a terminal status that could resurrect the run.
      const cancelled = this.deps.runRepository.findByUuid(run.uuid);
      if (
        cancelled &&
        ['cancelled', 'failed', 'blocked', 'needs_human_review', 'passed'].includes(
          cancelled.status,
        )
      ) {
        return { run: cancelled, phases };
      }

      // Run handler
      // Use `currentRun` (not the function-parameter `run`) so context-derived
      // state like `priorPhaseName` reflects phases completed earlier in this
      // same execution. The function-parameter `run` was captured before any
      // phase completed, so its `completedPhases` would always be empty.
      const ctx = this.buildContext(currentRun, approvedInboundPaths);
      let result: PhaseResult;
      try {
        result = await handler.run(ctx);
      } catch (err) {
        // Re-read again — cancellation may have occurred during handler execution
        const cancelledNow = this.deps.runRepository.findByUuid(run.uuid);
        if (
          cancelledNow &&
          ['cancelled', 'failed', 'blocked', 'passed'].includes(cancelledNow.status)
        ) {
          return { run: cancelledNow, phases };
        }
        if (err instanceof HandlerNotWiredError) {
          const failure: Failure = {
            runUuid: currentRun.uuid,
            phase: phaseDef.name as string,
            kind: 'handler_not_wired',
            message: err.message,
            canRetry: false,
            suggestedAction: `Phase handler for "${phaseDef.name}" is not wired. Register a real PhaseHandler implementation before invoking RunExecutor.`,
            artifacts: [],
            detectedAt: now(),
          };
          return this.blockRun(currentRun, phaseDef, phase, failure, now(), phases);
        }
        const failure: Failure = {
          runUuid: currentRun.uuid,
          phase: phaseDef.name as string,
          kind: 'command_failed',
          message: err instanceof Error ? err.message : String(err),
          canRetry: false,
          suggestedAction: 'Inspect handler execution error.',
          artifacts: [],
          detectedAt: now(),
        };
        return this.failRun(currentRun, phaseDef, phase, failure, now(), phases);
      }

      // Re-read persisted run state — cancellation may have occurred during handler execution.
      // Skip this guard when the handler returned `resting`: some handlers (e.g.
      // PostPrReviewHandler for timed_out/cancelled signals) set a terminal run
      // status and then return resting, and the resting branch must still run its
      // phase bookkeeping (update phase status, clear currentPhase).
      const cancelledAfterHandler = this.deps.runRepository.findByUuid(run.uuid);
      if (
        cancelledAfterHandler &&
        ['cancelled', 'failed', 'blocked', 'passed'].includes(cancelledAfterHandler.status) &&
        result.outcome !== 'resting'
      ) {
        return { run: cancelledAfterHandler, phases };
      }

      switch (result.outcome) {
        case 'deferred':
        case 'passed': {
          const status = result.outcome as 'deferred' | 'passed';
          currentRun = completePhase(currentRun, phaseDef.name as string);
          phase.status = status;
          phase.completedAt = now();
          for (const output of phaseDef.outputs) {
            if (!presentArtifacts.includes(output)) {
              presentArtifacts.push(output);
            }
          }
          // Refresh artifact presence from the artifact store BEFORE
          // persisting phase completion. If the store is unavailable we
          // still have the declared outputs — no need to fail the phase.
          try {
            const stored = await ctx.artifacts.list(run.uuid);
            for (const a of stored) {
              if (!presentArtifacts.includes(a.relativePath)) {
                presentArtifacts.push(a.relativePath);
              }
            }
          } catch {
            // non-fatal — declared outputs already accumulated
          }
          this.deps.phaseRepository.update(phase);
          this.deps.runRepository.update(run.uuid, {
            currentPhase: null,
            completedPhases: currentRun.completedPhases,
          });
          // Deferred phases emit 'phase.completed' because the executor's
          // processing is done — the handler returned, results are persisted,
          // and the pipeline continues. Event consumers that need to distinguish
          // can check the event message string (which says "deferred") or the
          // run step's status field.
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
          break;
        }
        case 'skipped': {
          currentRun = skipPhase(currentRun, phaseDef.name as string);
          phase.status = 'skipped';
          phase.completedAt = now();
          // Refresh actual artifact presence from the artifact store —
          // do NOT accumulate declared outputs (the handler chose not to run).
          try {
            const stored = await ctx.artifacts.list(run.uuid);
            for (const a of stored) {
              if (!presentArtifacts.includes(a.relativePath)) {
                presentArtifacts.push(a.relativePath);
              }
            }
          } catch {
            // non-fatal — handler chose to skip, no declared outputs to lose
          }
          this.deps.phaseRepository.update(phase);
          this.deps.runRepository.update(run.uuid, {
            currentPhase: null,
            skippedPhases: currentRun.skippedPhases,
          });
          // Do NOT accumulate declared outputs — the handler chose not to run
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
          break;
        }
        case 'resting': {
          phase.status = 'resting';
          phase.completedAt = now();
          this.deps.phaseRepository.update(phase);
          const restingRun = { ...currentRun };
          delete restingRun.currentPhase;
          this.deps.runRepository.update(run.uuid, {
            currentPhase: null,
          });
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
          return { run: restingRun, phases };
        }
        case 'failed': {
          return this.failRun(currentRun, phaseDef, phase, result.failure, now(), phases);
        }
        case 'blocked': {
          return this.blockRun(currentRun, phaseDef, phase, result.failure, now(), phases);
        }
        case 'needs_human_review': {
          return this.needsHumanReviewRun(
            currentRun,
            phaseDef,
            phase,
            result.failure,
            now(),
            phases,
          );
        }
      }
    }

    // Re-read persisted state — run may have been cancelled during the last handler
    const cancelledFinal = this.deps.runRepository.findByUuid(run.uuid);
    if (
      cancelledFinal &&
      ['cancelled', 'failed', 'blocked', 'passed'].includes(cancelledFinal.status)
    ) {
      return { run: cancelledFinal, phases };
    }

    // All phases passed — mark run passed
    const finalRun = passRun(currentRun, now());
    this.terminalStatusWrite(run.uuid, 'passed', {
      status: 'passed',
      currentPhase: null,
      completedAt: now(),
      failureReason: null,
    });
    this.emit(
      run.displayId,
      run.uuid,
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

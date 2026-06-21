import type { Run, Phase, PhaseName, PhaseStatus, Failure } from '@ai-sdlc/domain';
import { startPhase, completePhase, skipPhase, failRun, passRun, blockRun, markRunNeedsHumanReview } from '@ai-sdlc/domain';
import type { PhaseHandlerContext, PhaseResult } from '../phases/handler.js';
import type { PhaseDefinition } from '../phases/phase-definitions.js';
import {
  CANONICAL_PHASE_ORDER,
  PHASE_DEFINITIONS,
  orderedPhases,
  assertInputsAvailable,
  MissingRequiredInputError,
} from '../phases/phase-definitions.js';
import type { RunRepositoryPort, FailureRepositoryPort } from '../ports.js';
import type { PhaseRepositoryPort } from '../ports/phase-repository-port.js';
import type { EventBusPort } from '../ports/event-bus-port.js';
import type { PhaseHandlerRegistryPort } from '../ports/phase-handler-registry-port.js';

export interface RunExecutorDeps {
  runRepository: RunRepositoryPort;
  failureRepository: FailureRepositoryPort;
  phaseRepository: PhaseRepositoryPort;
  events: EventBusPort;
  registry: PhaseHandlerRegistryPort;
  contextFactory: () => PhaseHandlerContext;
  now?: () => Date;
}

export interface ExecuteRunInput {
  run: Run;
  skip: PhaseName[];
  presentArtifacts: string[];
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

    // When resuming with completedPhases, verify that declared outputs
    // actually exist in the artifact store.  If they are missing (crash,
    // manual cleanup, data corruption) we fail fast with a clear mismatch
    // error instead of trustingly accumulating the path into
    // presentArtifacts and letting a downstream handler hit an
    // ArtifactNotFoundError with a confusing message.
    let storedArtifacts: Set<string> | undefined;
    if (completedSet.size > 0) {
      try {
        const ctx = this.deps.contextFactory();
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
    if (cancelled && ['cancelled', 'failed', 'blocked', 'needs_human_review', 'passed'].includes(cancelled.status)) {
        return { run: cancelled, phases };
      }

      // Run handler
      const ctx = this.deps.contextFactory();
      if (!ctx.runUuid) {
        throw new Error(
          'RunExecutor contextFactory returned empty runUuid — wire a real contextFactory before invoking RunExecutor',
        );
      }
      let result: PhaseResult;
      try {
        result = await handler.run(ctx);
      } catch (err) {
        // Re-read again — cancellation may have occurred during handler execution
        const cancelledNow = this.deps.runRepository.findByUuid(run.uuid);
        if (cancelledNow && ['cancelled', 'failed', 'blocked', 'passed'].includes(cancelledNow.status)) {
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
      if (cancelledAfterHandler && ['cancelled', 'failed', 'blocked', 'passed'].includes(cancelledAfterHandler.status) && result.outcome !== 'resting') {
        return { run: cancelledAfterHandler, phases };
      }

      switch (result.outcome) {
        case 'passed': {
          currentRun = completePhase(currentRun, phaseDef.name as string);
          phase.status = 'passed';
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
          phases.push({ phase: phaseDef.name, status: 'passed' });
          this.emit(
            run.displayId,
            run.uuid,
            phaseDef.name as string,
            'info',
            'phase.completed',
            `phase '${String(phaseDef.name)}' completed`,
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
          return this.needsHumanReviewRun(currentRun, phaseDef, phase, result.failure, now(), phases);
        }
      }
    }

    // Re-read persisted state — run may have been cancelled during the last handler
    const cancelledFinal = this.deps.runRepository.findByUuid(run.uuid);
    if (cancelledFinal && ['cancelled', 'failed', 'blocked', 'passed'].includes(cancelledFinal.status)) {
      return { run: cancelledFinal, phases };
    }

    // All phases passed — mark run passed
    const finalRun = passRun(currentRun, now());
    this.deps.runRepository.update(run.uuid, { status: 'passed', completedAt: now() });
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
    this.deps.runRepository.update(run.uuid, {
      status: 'failed',
      currentPhase: null,
      completedAt: at,
      failureReason: failure.message,
    });
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
    this.deps.runRepository.update(run.uuid, {
      status: 'blocked',
      currentPhase: null,
      completedAt: at,
      failureReason: failure.message,
    });
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
    this.deps.phaseRepository.update(phase);
    this.deps.failureRepository.insert(failure);
    this.deps.runRepository.update(run.uuid, {
      status: 'needs_human_review',
      currentPhase: null,
      completedAt: at,
      failureReason: failure.message,
    });
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

  private emit(
    runId: string,
    runUuid: string,
    phase: string | undefined,
    level: 'info' | 'warn' | 'error',
    type: string,
    message: string,
    now: Date,
  ): void {
    this.deps.events.publish(runUuid, {
      runId,
      ...(phase !== undefined ? { phase } : {}),
      level,
      type,
      message,
      timestamp: now.toISOString(),
      metadata: {},
    });
  }
}

import type { Run, Phase, PhaseName, PhaseStatus, Failure } from '@ai-sdlc/domain';
import { startPhase, completePhase, failRun, passRun, blockRun } from '@ai-sdlc/domain';
import type { PhaseHandlerContext, PhaseResult } from '../phases/handler.js';
import type { PhaseDefinition } from '../phases/phase-definitions.js';
import {
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

export class RunExecutor {
  constructor(private readonly deps: RunExecutorDeps) {}

  async execute(input: ExecuteRunInput): Promise<ExecuteRunOutput> {
    const { run, skip } = input;
    const now = this.deps.now ?? (() => new Date());
    const phases: PhaseRecord[] = [];
    const presentArtifacts: string[] = [...input.presentArtifacts];
    let currentRun: Run = { ...run };

    const phaseDefs = orderedPhases(skip);

    // Record skipped phases pre-loop
    for (const phaseName of skip) {
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
    }

    // Main phase loop
    for (const phaseDef of phaseDefs) {
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

      const phase: Phase = {
        id: this.phaseId(run.uuid, phaseDef.name),
        runUuid: run.uuid,
        name: phaseDef.name as string,
        status: 'running',
        attempt: 1,
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

      // Run handler
      const ctx = this.deps.contextFactory();
      let result: PhaseResult;
      try {
        result = await handler.run(ctx);
      } catch (err) {
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

      switch (result.outcome) {
        case 'passed':
        case 'skipped': {
          currentRun = completePhase(currentRun, phaseDef.name as string);
          phase.status = 'passed';
          phase.completedAt = now();
          this.deps.phaseRepository.update(phase);
          this.deps.runRepository.update(run.uuid, {
            currentPhase: null,
            completedPhases: currentRun.completedPhases,
          });
          for (const output of phaseDef.outputs) {
            if (!presentArtifacts.includes(output)) {
              presentArtifacts.push(output);
            }
          }
          // Refresh artifact presence from the actual store — what the handler
          // produced takes precedence over declared outputs.
          const stored = await ctx.artifacts.list(run.uuid);
          for (const a of stored) {
            if (!presentArtifacts.includes(a.relativePath)) {
              presentArtifacts.push(a.relativePath);
            }
          }
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
      }
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

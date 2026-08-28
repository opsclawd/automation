import { PhaseName } from '@ai-sdlc/domain';
import type { PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { SingleShotAgentHandler } from './single-shot-agent-handler.js';
import { runSingleShotAgentPhase } from './run-single-shot-agent-phase.js';
import { getPhaseDefinition } from '../phase-definitions.js';
import { validatePlanTaskList } from '../plan-tasks.js';
import { ArtifactNotFoundError } from '../../ports/artifact-store.js';
import type { EventBusPort } from '../../ports/event-bus-port.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

export interface PlanWriteHandlerOpts {
  /** Number of repair attempts allowed after the initial validation failure.
   *  0 reproduces pre-repair-loop behavior: immediate hard-fail on first failure. */
  maxRepairAttempts?: number;
}

interface ReadArtifactsResult {
  planMd?: string | undefined;
  manifestJson?: string | undefined;
  readFailure?: PhaseResult | undefined;
}

export class PlanWriteHandler extends SingleShotAgentHandler {
  private readonly maxRepairAttempts: number;

  constructor(opts: PlanWriteHandlerOpts = {}) {
    super(PhaseName('plan-write'), 'plan-write', { skipResultExtraction: true });
    this.maxRepairAttempts = opts.maxRepairAttempts ?? 2;
  }

  override async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);

    const completedRef: { event?: { runUuid: string; event: OrchestratorEvent } } = {};
    const interceptedEvents: EventBusPort = {
      subscribe: (runUuid, listener) => ctx.events.subscribe(runUuid, listener),
      publish: (runUuid, event) => {
        if (event.type === 'plan-write.completed') {
          completedRef.event = { runUuid, event };
          return;
        }
        ctx.events.publish(runUuid, event);
      },
    };

    const wrappedCtx = Object.create(ctx) as PhaseHandlerContext;
    wrappedCtx.events = interceptedEvents;

    const result = await super.run(wrappedCtx);
    if (result.outcome !== 'passed') {
      return result;
    }

    const initialRead = await this.readArtifacts(ctx, emit);
    if (initialRead.readFailure) {
      return initialRead.readFailure;
    }

    let planMd = initialRead.planMd!;
    let manifestJson = initialRead.manifestJson;
    let validation = validatePlanTaskList(planMd, manifestJson, ctx, 'plan-write');

    let finalResult = result;
    let attempt = 0;
    while (!validation.success && attempt < this.maxRepairAttempts) {
      attempt += 1;
      const validationError = validation.error;
      emit(
        'plan-write.repair.started',
        'info',
        `repair attempt ${attempt}/${this.maxRepairAttempts}: ${validationError}`,
        { attempt, validationError },
      );

      // Ensure the current draft plan and manifest are persisted to artifact store for repair prompt interpolation
      try {
        await ctx.artifacts.write({
          runId: ctx.runUuid,
          phaseId: 'plan-write',
          relativePath: 'plan.md',
          contents: planMd,
        });
        if (manifestJson !== undefined) {
          await ctx.artifacts.write({
            runId: ctx.runUuid,
            phaseId: 'plan-write',
            relativePath: 'task-manifest.json',
            contents: manifestJson,
          });
        }
      } catch {
        // Best-effort write
      }

      let wrappedCtxForRepair = wrappedCtx;
      if (manifestJson === undefined) {
        const placeholderManifest = JSON.stringify({ version: 1, task_count: 0, tasks: [] });
        const wrappedArtifacts = Object.create(ctx.artifacts) as typeof ctx.artifacts;
        wrappedArtifacts.read = async (runId: string, relativePath: string) => {
          if (relativePath === 'task-manifest.json') {
            try {
              return await ctx.artifacts.read(runId, relativePath);
            } catch (e) {
              if (
                e instanceof ArtifactNotFoundError ||
                (e instanceof Error && e.name === 'ArtifactNotFoundError')
              ) {
                return placeholderManifest;
              }
              throw e;
            }
          }
          return ctx.artifacts.read(runId, relativePath);
        };
        wrappedCtxForRepair = Object.create(wrappedCtx) as PhaseHandlerContext;
        wrappedCtxForRepair.artifacts = wrappedArtifacts;
      }

      const def = getPhaseDefinition(this.phase);
      if (!def.agentContract || !ctx.resolveProfile) {
        const message = `${this.phase} phase definition missing agentContract or resolveProfile`;
        emit('plan-write.failed', 'error', message);
        return {
          outcome: 'failed',
          failure: {
            runUuid: ctx.runUuid,
            phase: this.phase,
            kind: 'command_failed',
            message,
            canRetry: false,
            suggestedAction: 'Ensure the compose root wires agentContract and resolveProfile.',
            artifacts: [],
            detectedAt: ctx.now(),
          },
        };
      }

      const repairResult = await runSingleShotAgentPhase(wrappedCtxForRepair, {
        phase: this.phase,
        profile: ctx.resolveProfile(this.phase),
        step: 'plan-write-repair',
        vars: {
          issue_number: String(ctx.issueNumber),
          cwd: ctx.cwd,
          validation_error: validationError,
        },
        agentContract: def.agentContract,
        skipResultExtraction: true,
      });

      if (repairResult.outcome !== 'passed') {
        // The repair agent invocation itself failed/was blocked (contract violation,
        // agent crash, etc.) — runSingleShotAgentPhase already emitted the relevant
        // plan-write.failed/plan-write.blocked event. Propagate it as-is rather than
        // reframing as a structural-validation failure.
        return repairResult;
      }

      finalResult = repairResult;

      const reread = await this.readArtifacts(ctx, emit);
      if (reread.readFailure) {
        return reread.readFailure;
      }
      planMd = reread.planMd!;
      manifestJson = reread.manifestJson;
      validation = validatePlanTaskList(planMd, manifestJson, ctx, 'plan-write');

      if (validation.success) {
        emit(
          'plan-write.repair.succeeded',
          'info',
          `repair attempt ${attempt} produced a valid plan`,
          { attempt },
        );
      } else {
        emit(
          'plan-write.repair.failed',
          'warn',
          `repair attempt ${attempt} still invalid: ${validation.error}`,
          { attempt, validationError: validation.error },
        );
      }
    }

    if (!validation.success) {
      emit('plan-write.failed', 'error', validation.error);
      return {
        outcome: 'failed',
        failure: {
          runUuid: ctx.runUuid,
          phase: this.phase,
          kind: 'invalid_result',
          message: validation.error,
          canRetry: false,
          suggestedAction: 'Review and fix the plan or task manifest structure.',
          artifacts: [],
          detectedAt: ctx.now(),
        },
      };
    }

    try {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: 'plan-write',
        relativePath: 'plan.md',
        contents: planMd,
      });
      emit('artifact.created', 'info', 'wrote plan.md', { path: 'plan.md' });
    } catch (e) {
      const message = `Failed to write plan.md artifact: ${e instanceof Error ? e.message : String(e)}`;
      emit('plan-write.failed', 'error', message);
      return {
        outcome: 'failed',
        failure: {
          runUuid: ctx.runUuid,
          phase: this.phase,
          kind: 'unknown',
          message,
          canRetry: false,
          suggestedAction: 'Check disk space or artifact store integrity.',
          artifacts: [],
          detectedAt: ctx.now(),
        },
      };
    }

    if (manifestJson !== undefined) {
      try {
        await ctx.artifacts.write({
          runId: ctx.runUuid,
          phaseId: 'plan-write',
          relativePath: 'task-manifest.json',
          contents: manifestJson,
        });
        emit('artifact.created', 'info', 'wrote task-manifest.json', {
          path: 'task-manifest.json',
        });
      } catch (e) {
        const message = `Failed to write task-manifest.json artifact: ${e instanceof Error ? e.message : String(e)}`;
        emit('plan-write.failed', 'error', message);
        return {
          outcome: 'failed',
          failure: {
            runUuid: ctx.runUuid,
            phase: this.phase,
            kind: 'unknown',
            message,
            canRetry: false,
            suggestedAction: 'Check disk space or artifact store integrity.',
            artifacts: [],
            detectedAt: ctx.now(),
          },
        };
      }
    }

    if (completedRef.event) {
      ctx.events.publish(completedRef.event.runUuid, completedRef.event.event);
    } else {
      emit('plan-write.completed', 'info', 'plan-write completed');
    }

    return finalResult;
  }

  private async readArtifacts(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
  ): Promise<ReadArtifactsResult> {
    let rawResult: string;
    try {
      rawResult = await ctx.artifacts.read(ctx.runUuid, 'result.json');
    } catch (e) {
      const message = `Failed to read result.json: ${e instanceof Error ? e.message : String(e)}`;
      emit('plan-write.failed', 'error', message);
      return {
        readFailure: {
          outcome: 'failed',
          failure: {
            runUuid: ctx.runUuid,
            phase: this.phase,
            kind: 'invalid_result',
            message,
            canRetry: false,
            suggestedAction: 'Ensure the agent generated a result.json.',
            artifacts: [],
            detectedAt: ctx.now(),
          },
        },
      };
    }

    let parsed: { plan_md?: unknown; task_manifest?: unknown; [key: string]: unknown };
    try {
      parsed = JSON.parse(rawResult);
    } catch (e) {
      const message = `Failed to parse result.json: ${e instanceof Error ? e.message : String(e)}`;
      emit('plan-write.failed', 'error', message);
      return {
        readFailure: {
          outcome: 'failed',
          failure: {
            runUuid: ctx.runUuid,
            phase: this.phase,
            kind: 'invalid_result',
            message,
            canRetry: false,
            suggestedAction: 'Ensure the agent produced valid JSON in result.json.',
            artifacts: [],
            detectedAt: ctx.now(),
          },
        },
      };
    }

    if (typeof parsed.plan_md !== 'string' || parsed.plan_md.trim().length === 0) {
      const message = 'result.json is missing required non-empty plan_md field';
      emit('plan-write.failed', 'error', message);
      return {
        readFailure: {
          outcome: 'failed',
          failure: {
            runUuid: ctx.runUuid,
            phase: this.phase,
            kind: 'invalid_result',
            message,
            canRetry: false,
            suggestedAction:
              'Ensure result.json includes plan_md with the markdown implementation plan.',
            artifacts: [],
            detectedAt: ctx.now(),
          },
        },
      };
    }

    const planMd = parsed.plan_md;

    let manifestJson: string | undefined;
    if (parsed.task_manifest !== undefined && parsed.task_manifest !== null) {
      if (typeof parsed.task_manifest === 'string') {
        manifestJson = parsed.task_manifest;
      } else if (typeof parsed.task_manifest === 'object') {
        manifestJson = JSON.stringify(parsed.task_manifest, null, 2);
      } else {
        manifestJson = String(parsed.task_manifest);
      }
    }

    return { planMd, manifestJson };
  }
}

import { PhaseName } from '@ai-sdlc/domain';
import type { FailureKind } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import type { StepRepositoryPort } from '../../ports/step-repository-port.js';
import type { Step, RunId } from '@ai-sdlc/domain';
import { createEventEmitter } from '../handler.js';
import { ArtifactNotFoundError } from '../../ports/artifact-store.js';
import { validatePlanTaskList, derivePlanTasks, extractTaskBody } from '../plan-tasks.js';

export interface StepRunContext {
  stepIndex: number;
  stepTitle: string;
  cwd: string;
  ctx: PhaseHandlerContext;
}

export interface StepRunResult {
  outcome: 'success' | 'failed' | 'needs_human_review';
}

export interface ImplementHandlerOpts {
  steps: StepRepositoryPort;
  runStep: (sctx: StepRunContext) => Promise<StepRunResult>;
  setup?: (cwd: string) => Promise<{ ok: boolean; error?: string }>;
}

export class ImplementHandler implements PhaseHandler {
  readonly phase = PhaseName('implement');

  constructor(private readonly opts: ImplementHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('implement.started', 'info', 'implement started');

    const planMd = await this.readPlan(ctx, emit);
    if (typeof planMd !== 'string') return planMd;

    let manifestJson: string | undefined;
    try {
      manifestJson = await ctx.artifacts.read(ctx.runUuid, 'task-manifest.json');
    } catch (e) {
      if (e instanceof ArtifactNotFoundError) {
        manifestJson = undefined;
      } else {
        const message = `Failed to read task-manifest.json: ${e instanceof Error ? e.message : String(e)}`;
        return this.fail(ctx, emit, 'unknown', message);
      }
    }

    const validation = validatePlanTaskList(planMd, manifestJson, ctx, 'implement');
    if (!validation.success) {
      return this.fail(ctx, emit, 'invalid_result', validation.error);
    }
    const manifest = validation.manifest;

    const derived = derivePlanTasks(planMd, manifest);
    if (derived.length === 0) {
      return this.fail(
        ctx,
        emit,
        'invalid_result',
        manifest ? 'plan.md has no manifest steps' : 'plan.md has no "## Task" steps',
      );
    }

    for (const d of derived) {
      const task = manifest?.tasks.find((t) => t.n === d.index);
      const bodyResult = extractTaskBody(planMd, {
        taskNumber: d.index,
        ...(task?.title !== undefined ? { title: task.title } : {}),
      });
      if (!bodyResult.ok) {
        return this.fail(
          ctx,
          emit,
          'invalid_result',
          `Task ${d.index} has no acceptable heading in plan.md`,
        );
      }
    }

    const existing = this.opts.steps.listForRun(ctx.runUuid as RunId);
    const doneIdx = new Set(
      existing
        .filter((s) => s.phaseId === 'implement' && s.status === 'success')
        .map((s) => s.index),
    );

    if (this.opts.setup && derived.some((d) => !doneIdx.has(d.index))) {
      try {
        const result = await this.opts.setup(ctx.cwd);
        if (!result.ok) {
          return this.fail(ctx, emit, 'setup_failed', result.error ?? 'setup failed');
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return this.fail(ctx, emit, 'setup_failed', `setup crashed: ${message}`);
      }
    }

    for (const d of derived) {
      if (doneIdx.has(d.index)) {
        emit('step.skipped', 'info', `step ${d.index} already complete`, { index: d.index });
        continue;
      }

      const startedAt = ctx.now();
      const step: Step = {
        id: ctx.idFactory?.() ?? `${ctx.runUuid}:implement:${d.index}`,
        runId: ctx.runUuid,
        phaseId: this.phase,
        index: d.index,
        title: d.title,
        status: 'running',
        startedAt,
      };
      this.opts.steps.upsert(step);
      emit('step.started', 'info', `step ${d.index}: ${d.title}`, { index: d.index });

      let result: StepRunResult;
      try {
        result = await this.opts.runStep({
          stepIndex: d.index,
          stepTitle: d.title,
          cwd: ctx.cwd,
          ctx,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.opts.steps.upsert({ ...step, status: 'failed', completedAt: ctx.now() });
        emit('step.failed', 'error', `step ${d.index} crashed: ${message}`, { index: d.index });
        return this.fail(
          ctx,
          emit,
          'command_failed',
          `step ${d.index} (${d.title}) crashed: ${message}`,
        );
      }

      if (result.outcome === 'success') {
        this.opts.steps.upsert({ ...step, status: 'success', completedAt: ctx.now() });
        emit('step.completed', 'info', `step ${d.index} done`, { index: d.index });
      } else if (result.outcome === 'needs_human_review') {
        this.opts.steps.upsert({ ...step, status: 'needs_human_review', completedAt: ctx.now() });
        emit('step.needs_human_review', 'warn', `step ${d.index} needs human review`, {
          index: d.index,
        });
        return this.needsHumanReview(
          ctx,
          emit,
          'agent_incomplete',
          `step ${d.index} (${d.title}) needs human review`,
        );
      } else {
        this.opts.steps.upsert({ ...step, status: 'failed', completedAt: ctx.now() });
        emit('step.failed', 'error', `step ${d.index} failed`, { index: d.index });
        return this.fail(ctx, emit, 'agent_incomplete', `step ${d.index} (${d.title}) failed`);
      }
    }

    emit('implement.completed', 'info', 'implement complete');
    return { outcome: 'passed' };
  }

  private async readPlan(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
  ): Promise<string | PhaseResult> {
    try {
      return await ctx.artifacts.read(ctx.runUuid, 'plan.md');
    } catch (e) {
      const message =
        e instanceof ArtifactNotFoundError
          ? 'plan.md not found in artifact store'
          : `Failed to read plan.md: ${e instanceof Error ? e.message : String(e)}`;
      return this.fail(
        ctx,
        emit,
        e instanceof ArtifactNotFoundError ? 'missing_artifact' : 'unknown',
        message,
      );
    }
  }

  private fail(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
    kind: FailureKind,
    message: string,
  ): PhaseResult {
    emit('implement.failed', 'error', message);
    return {
      outcome: 'failed',
      failure: {
        runUuid: ctx.runUuid,
        phase: 'implement',
        kind,
        message,
        canRetry: kind !== 'invalid_result',
        suggestedAction:
          kind === 'invalid_result'
            ? 'Ensure plan.md contains "## Task" headings.'
            : 'Inspect the failing step artifacts and resume.',
        artifacts: [],
        detectedAt: ctx.now(),
      },
    };
  }

  private needsHumanReview(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
    kind: FailureKind,
    message: string,
  ): PhaseResult {
    emit('implement.needs_human_review', 'warn', message);
    return {
      outcome: 'needs_human_review',
      failure: {
        runUuid: ctx.runUuid,
        phase: 'implement',
        kind,
        message,
        canRetry: true,
        suggestedAction: 'Review the step that needs attention and resume.',
        artifacts: [],
        detectedAt: ctx.now(),
      },
    };
  }
}

import { PhaseName, type Failure } from '@ai-sdlc/domain';
import type { PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { SingleShotAgentHandler } from './single-shot-agent-handler.js';
import { runSingleShotAgentPhase } from './run-single-shot-agent-phase.js';
import { loadPromptTemplate } from '../../prompts/load-prompt-template.js';
import { plannerPackageSchema } from '../../results/schemas/planner-package.js';
import { validatePlanTaskList } from '../plan-tasks.js';

export class PlanDesignHandler extends SingleShotAgentHandler {
  constructor() {
    super(PhaseName('plan-design'), 'plan-design', { skipResultExtraction: true });
  }

  override async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const isLeanPolicy = ctx.executionPolicy === 'standard' || ctx.executionPolicy === 'strict';
    if (!isLeanPolicy) {
      return super.run(ctx);
    }

    const emit: EventEmitter = createEventEmitter(ctx, this.phase);
    emit('plan-design.started', 'info', 'starting plan-design');

    // 1. Resume / retry idempotency check: reuse valid planning artifacts if already present
    try {
      const design = await ctx.artifacts.read(ctx.runUuid, 'design.md');
      const plan = await ctx.artifacts.read(ctx.runUuid, 'plan.md');
      const manifest = await ctx.artifacts.read(ctx.runUuid, 'task-manifest.json');
      if (design.trim() && plan.trim() && manifest.trim()) {
        emit(
          'plan-design.completed',
          'info',
          'planning artifacts already present; reusing canonical artifacts',
        );
        return { outcome: 'passed' };
      }
    } catch {
      // Artifacts not present, proceed with single-shot planner invocation
    }

    // 2. Resolve profile
    if (!ctx.resolveProfile) {
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'plan-design',
        kind: 'command_failed',
        message: 'resolveProfile not available on context',
        canRetry: false,
        suggestedAction: 'Ensure context is built with resolveProfile in the compose root.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      emit('plan-design.failed', 'error', failure.message);
      return { outcome: 'failed', failure };
    }

    const profile = ctx.resolveProfile(this.phase);
    if (!profile) {
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'plan-design',
        kind: 'command_failed',
        message: `resolveProfile returned empty for phase '${this.phase}'`,
        canRetry: false,
        suggestedAction: 'Ensure the phase profile is configured in the compose root.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      emit('plan-design.failed', 'error', failure.message);
      return { outcome: 'failed', failure };
    }

    // 3. Load prompt template (try plan-unified first, fallback to plan-design)
    let template: string | undefined;
    if (ctx.promptsRoot) {
      try {
        template = loadPromptTemplate('plan-design', 'plan-unified', {
          promptsRoot: ctx.promptsRoot,
        });
      } catch {
        try {
          template = loadPromptTemplate('plan-design', 'plan-design', {
            promptsRoot: ctx.promptsRoot,
          });
        } catch {
          // Template will be loaded or thrown in runSingleShotAgentPhase
        }
      }
    }

    // 4. Run single planner invocation without worktree delivery requirements
    const runResult = await runSingleShotAgentPhase(ctx, {
      phase: this.phase,
      profile,
      step: 'plan-unified',
      ...(template ? { template } : {}),
      vars: { issue_number: String(ctx.issueNumber), cwd: ctx.cwd },
      agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
      skipResultExtraction: true,
    });

    if (runResult.outcome !== 'passed') {
      return runResult;
    }

    // 5. Extract and parse structured result.json
    let rawJson: string;
    try {
      rawJson = await ctx.artifacts.read(ctx.runUuid, 'result.json');
    } catch {
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'plan-design',
        kind: 'invalid_result',
        message: 'Unified planner did not produce result.json artifact',
        canRetry: false,
        suggestedAction:
          'Ensure planner returns structured JSON with design_md, plan_md, and task_manifest.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      emit('plan-design.failed', 'error', failure.message);
      return { outcome: 'failed', failure };
    }

    let parsedObj: unknown;
    try {
      parsedObj = JSON.parse(rawJson);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'plan-design',
        kind: 'invalid_result',
        message: `Failed to parse result.json: ${message}`,
        canRetry: false,
        suggestedAction: 'Ensure planner returns valid JSON.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      emit('plan-design.failed', 'error', failure.message);
      return { outcome: 'failed', failure };
    }

    const parseResult = plannerPackageSchema.safeParse(parsedObj);
    if (!parseResult.success) {
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'plan-design',
        kind: 'invalid_result',
        message: `Result schema validation failed: ${parseResult.error.message}`,
        canRetry: false,
        suggestedAction: 'Ensure planner returns design_md, plan_md, and a valid task_manifest.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      emit('plan-design.failed', 'error', failure.message);
      return { outcome: 'failed', failure };
    }

    const { design_md, plan_md, task_manifest } = parseResult.data;

    // 6. Deterministic validation on plan and manifest
    const manifestJson =
      typeof task_manifest === 'string' ? task_manifest : JSON.stringify(task_manifest, null, 2);
    const validation = validatePlanTaskList(plan_md, manifestJson, ctx, 'plan-design');
    if (!validation.success) {
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'plan-design',
        kind: 'invalid_result',
        message: `Deterministic plan check failed: ${validation.error}`,
        canRetry: false,
        suggestedAction: 'Ensure plan tasks and manifest match and follow structural requirements.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      emit('plan-design.failed', 'error', failure.message);
      return { outcome: 'failed', failure };
    }

    // 7. Application-owned canonical artifact persistence
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: design_md,
    });
    emit('artifact.created', 'info', 'artifact created: design.md', { relativePath: 'design.md' });

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-design',
      relativePath: 'plan.md',
      contents: plan_md,
    });
    emit('artifact.created', 'info', 'artifact created: plan.md', { relativePath: 'plan.md' });

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-design',
      relativePath: 'task-manifest.json',
      contents: manifestJson,
    });
    emit('artifact.created', 'info', 'artifact created: task-manifest.json', {
      relativePath: 'task-manifest.json',
    });

    emit('plan-design.completed', 'info', 'plan-design completed');
    return { outcome: 'passed' };
  }
}

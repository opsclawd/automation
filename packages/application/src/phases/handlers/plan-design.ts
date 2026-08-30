import { PhaseName, type Failure } from '@ai-sdlc/domain';
import type { PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { SingleShotAgentHandler } from './single-shot-agent-handler.js';
import { runSingleShotAgentPhase } from './run-single-shot-agent-phase.js';
import { loadPromptTemplate } from '../../prompts/load-prompt-template.js';
import type { PlannerPackage } from '../../results/schemas/planner-package.js';
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
      if (design.trim() && plan.trim()) {
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
    const runResult = await runSingleShotAgentPhase<PlannerPackage>(ctx, {
      phase: this.phase,
      profile,
      step: 'plan-unified',
      ...(template ? { template } : {}),
      vars: { issue_number: String(ctx.issueNumber), cwd: ctx.cwd },
      agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
      skipCompletedEmit: true,
    });

    if (runResult.outcome !== 'passed') {
      return runResult;
    }

    const { design_md, plan_md } = runResult.result;

    // 6. Deterministic validation on plan
    const validation = validatePlanTaskList(plan_md, undefined, ctx, 'plan-design');
    if (!validation.success) {
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'plan-design',
        kind: 'invalid_result',
        message: `Deterministic plan check failed: ${validation.error}`,
        canRetry: false,
        suggestedAction: 'Ensure plan tasks follow structural requirements.',
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

    emit('plan-design.completed', 'info', 'plan-design completed');
    return { outcome: 'passed' };
  }
}

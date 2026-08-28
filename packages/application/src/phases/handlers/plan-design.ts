import { PhaseName } from '@ai-sdlc/domain';
import type { PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { SingleShotAgentHandler } from './single-shot-agent-handler.js';

export class PlanDesignHandler extends SingleShotAgentHandler {
  constructor() {
    super(PhaseName('plan-design'), 'plan-design', {
      skipResultExtraction: true,
      skipCompletedEmit: true,
    });
  }

  override async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);

    const result = await super.run(ctx);
    if (result.outcome !== 'passed') {
      return result;
    }

    let rawResult: string;
    try {
      rawResult = await ctx.artifacts.read(ctx.runUuid, 'result.json');
    } catch (e) {
      const message = `Failed to read result.json: ${e instanceof Error ? e.message : String(e)}`;
      emit('plan-design.failed', 'error', message);
      return {
        outcome: 'failed',
        failure: {
          runUuid: ctx.runUuid,
          phase: this.phase,
          kind: 'invalid_result',
          message,
          canRetry: false,
          suggestedAction: 'Ensure the agent generated a result.json with design_md.',
          artifacts: [],
          detectedAt: ctx.now(),
        },
      };
    }

    let parsed: { design_md?: unknown; [key: string]: unknown };
    try {
      parsed = JSON.parse(rawResult);
    } catch (e) {
      const message = `Failed to parse result.json: ${e instanceof Error ? e.message : String(e)}`;
      emit('plan-design.failed', 'error', message);
      return {
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
      };
    }

    if (typeof parsed.design_md !== 'string' || parsed.design_md.trim().length === 0) {
      const message = 'result.json is missing required non-empty design_md field';
      emit('plan-design.failed', 'error', message);
      return {
        outcome: 'failed',
        failure: {
          runUuid: ctx.runUuid,
          phase: this.phase,
          kind: 'invalid_result',
          message,
          canRetry: false,
          suggestedAction:
            'Ensure result.json includes design_md with the markdown design document.',
          artifacts: [],
          detectedAt: ctx.now(),
        },
      };
    }

    try {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: 'plan-design',
        relativePath: 'design.md',
        contents: parsed.design_md,
      });
      emit('artifact.created', 'info', 'wrote design.md', { path: 'design.md' });
    } catch (e) {
      const message = `Failed to write design.md artifact: ${e instanceof Error ? e.message : String(e)}`;
      emit('plan-design.failed', 'error', message);
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

    emit('plan-design.completed', 'info', 'plan-design completed');
    return { outcome: 'passed' };
  }
}

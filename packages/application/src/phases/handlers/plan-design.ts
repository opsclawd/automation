import { PhaseName } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { getPhaseDefinition } from '../phase-definitions.js';
import { runSingleShotAgentPhase } from './run-single-shot-agent-phase.js';

export class PlanDesignHandler implements PhaseHandler {
  readonly phase = PhaseName('plan-design');

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('phase.started', 'info', 'starting plan-design');

    const def = getPhaseDefinition(this.phase);
    if (!def.agentContract) {
      throw new Error('plan-design phase definition missing agentContract');
    }

    const profile = ctx.resolveProfile?.(this.phase);
    if (!profile) {
      emit('phase.failed', 'error', 'resolveProfile not available on context');
      return {
        outcome: 'failed' as const,
        failure: {
          runUuid: ctx.runUuid,
          phase: this.phase,
          kind: 'command_failed' as const,
          message: 'resolveProfile not available on context',
          canRetry: false,
          suggestedAction: 'Ensure context is built with resolveProfile in the compose root.',
          artifacts: [],
          detectedAt: ctx.now(),
        },
      };
    }

    return runSingleShotAgentPhase(ctx, {
      phase: this.phase,
      profile,
      step: 'plan-design',
      vars: { issue_number: String(ctx.issueNumber) },
      agentContract: def.agentContract,
    });
  }
}

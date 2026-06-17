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

    return runSingleShotAgentPhase(ctx, {
      phase: this.phase,
      profile: ctx.resolveProfile!('plan-design'),
      step: 'plan-design',
      vars: { issue_number: String(ctx.issueNumber) },
      agentContract: def.agentContract,
    });
  }
}

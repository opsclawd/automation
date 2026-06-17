import { PhaseName } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { getPhaseDefinition } from '../phase-definitions.js';
import { runSingleShotAgentPhase } from './run-single-shot-agent-phase.js';

export class PlanWriteHandler implements PhaseHandler {
  readonly phase = PhaseName('plan-write');

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('phase.started', 'info', 'starting plan-write');

    const def = getPhaseDefinition(this.phase);
    if (!def.agentContract) {
      throw new Error('plan-write phase definition missing agentContract');
    }

    return runSingleShotAgentPhase(ctx, {
      phase: this.phase,
      profile: ctx.resolveProfile!('plan-write'),
      step: 'plan-write',
      vars: { issue_number: String(ctx.issueNumber) },
      agentContract: def.agentContract,
    });
  }
}

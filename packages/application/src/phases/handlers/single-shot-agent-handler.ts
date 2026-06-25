import { PhaseName } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { getPhaseDefinition } from '../phase-definitions.js';
import { runSingleShotAgentPhase } from './run-single-shot-agent-phase.js';

export class SingleShotAgentHandler implements PhaseHandler {
  readonly phase: PhaseName;

  constructor(
    phaseName: PhaseName,
    private readonly step: string,
    private readonly options: { skipResultExtraction?: boolean } = {},
  ) {
    this.phase = phaseName;
  }

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit(`${String(this.phase)}.started`, 'info', `starting ${this.phase}`);

    const def = getPhaseDefinition(this.phase);
    if (!def.agentContract) {
      const message = `${this.phase} phase definition missing agentContract`;
      emit(`${String(this.phase)}.failed`, 'error', message);
      return {
        outcome: 'failed' as const,
        failure: {
          runUuid: ctx.runUuid,
          phase: this.phase,
          kind: 'command_failed' as const,
          message,
          canRetry: false,
          suggestedAction:
            'Ensure the phase definition includes an agentContract in the compose root.',
          artifacts: [],
          detectedAt: ctx.now(),
        },
      };
    }

    if (ctx.resolveProfile === undefined) {
      emit(`${String(this.phase)}.failed`, 'error', 'resolveProfile not available on context');
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

    const profile = ctx.resolveProfile(this.phase);
    if (!profile) {
      const message = `resolveProfile returned empty for phase '${this.phase}'`;
      emit(`${String(this.phase)}.failed`, 'error', message);
      return {
        outcome: 'failed' as const,
        failure: {
          runUuid: ctx.runUuid,
          phase: this.phase,
          kind: 'command_failed' as const,
          message,
          canRetry: false,
          suggestedAction: 'Ensure the phase profile is configured in the compose root.',
          artifacts: [],
          detectedAt: ctx.now(),
        },
      };
    }

    const result = await runSingleShotAgentPhase(ctx, {
      phase: this.phase,
      profile,
      step: this.step,
      vars: { issue_number: String(ctx.issueNumber) },
      agentContract: def.agentContract,
      ...(this.options.skipResultExtraction ? { skipResultExtraction: true } : {}),
    });
    if (this.options.skipResultExtraction && result.outcome === 'passed') {
      emit(`${String(this.phase)}.completed`, 'info', `${String(this.phase)} completed`);
    }
    return result;
  }
}

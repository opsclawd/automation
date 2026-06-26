import type { PhaseName, Failure } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';

export interface FixValidateHandlerOpts {
  runLoop: (ctx: PhaseHandlerContext) => Promise<{
    phaseOutcome: 'passed' | 'failed';
    loopStatus: 'converged' | 'failed' | 'exhausted';
  }>;
}

export class FixValidateHandler implements PhaseHandler {
  readonly phase = 'fix-validate' as PhaseName;
  constructor(private readonly opts: FixValidateHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('fix_validate.started', 'info', 'fix-validate started');

    let phaseOutcome: 'passed' | 'failed';
    let loopStatus: 'converged' | 'failed' | 'exhausted';
    try {
      const result = await this.opts.runLoop(ctx);
      phaseOutcome = result.phaseOutcome;
      loopStatus = result.loopStatus;
    } catch (e) {
      const message = `validate/fix loop threw: ${e instanceof Error ? e.message : String(e)}`;
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'fix-validate',
        kind: 'unknown',
        message,
        canRetry: true,
        suggestedAction:
          'Inspect the validation output and loop iterations, then resume or intervene.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      emit('fix_validate.failed', 'error', message);
      return { outcome: 'failed', failure };
    }

    if (phaseOutcome === 'passed') {
      emit('fix_validate.completed', 'info', 'fix-validate converged');
      return { outcome: 'passed' };
    }
    const terminalStatus: 'exhausted' | 'failed' =
      loopStatus === 'exhausted' ? 'exhausted' : 'failed';
    const verboseMessage =
      terminalStatus === 'exhausted'
        ? 'validate/fix loop exhausted without converging'
        : 'validate/fix loop failed';
    const eventMessage =
      terminalStatus === 'exhausted' ? 'fix-validate loop exhausted' : 'fix-validate loop failed';
    emit('fix_validate.failed', 'error', eventMessage);
    return {
      outcome: 'failed',
      failure: {
        runUuid: ctx.runUuid,
        phase: 'fix-validate',
        kind: 'validation_failed',
        message: verboseMessage,
        canRetry: true,
        suggestedAction:
          'Inspect the validation output and loop iterations, then resume or intervene.',
        artifacts: [],
        detectedAt: ctx.now(),
      },
    };
  }
}

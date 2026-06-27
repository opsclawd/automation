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

    // fix-validate is only needed when validate returned 'deferred' (wrote
    // validate/failure.json). When validate passed it writes 'validation.result'
    // instead and there is nothing for this phase to do.
    try {
      const artifacts = await ctx.artifacts.list(ctx.runUuid);
      const hasFailure = artifacts.some((a) => a.relativePath === 'validate/failure.json');
      if (!hasFailure) {
        emit('fix_validate.skipped', 'info', 'fix-validate skipped — validation already passed');
        return { outcome: 'passed' };
      }
    } catch {
      // Non-fatal — proceed with the loop if the artifact store is unavailable.
    }

    emit('fix_validate.started', 'info', 'fix-validate started');

    try {
      const result = await this.opts.runLoop(ctx);
      if (result.phaseOutcome === 'passed') {
        emit('fix_validate.completed', 'info', 'fix-validate converged');
        return { outcome: 'passed' };
      }
      const loopStatus = result.loopStatus;
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
  }
}

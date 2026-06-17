import { PhaseName, type Failure } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import type { RunValidation } from '../../run-validation.js';

export interface ValidateHandlerOpts {
  runValidation: RunValidation;
  commands: string[];
  timeoutSeconds: number;
  logDir: string;
}

export class ValidateHandler implements PhaseHandler {
  readonly phase = PhaseName('validate');

  constructor(private readonly opts: ValidateHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('phase.started', 'info', 'validate started');

    const { passed, validationRun } = await this.opts.runValidation.execute({
      runId: ctx.runUuid as import('@ai-sdlc/domain').RunId,
      phaseId: this.phase,
      cwd: ctx.cwd,
      logDir: this.opts.logDir,
      commands: this.opts.commands,
      timeoutSeconds: this.opts.timeoutSeconds,
    });

    if (passed) {
      emit('phase.completed', 'info', 'validation passed', {
        commands: validationRun.commands.length,
      });
      return { outcome: 'passed' };
    }

    const failing = validationRun.commands
      .filter((c) => c.outcome !== 'passed')
      .map((c) => c.command);

    const failure: Failure = {
      runUuid: ctx.runUuid,
      phase: 'validate',
      kind: 'validation_failed',
      message: `validation failed: ${failing.join(', ')}`,
      canRetry: true,
      suggestedAction:
        'Inspect the failing command logs under the validate phase, fix, and resume.',
      artifacts: ['validate/validation-result.json'],
      detectedAt: ctx.now(),
    };

    emit('phase.failed', 'error', failure.message, { failing });
    return { outcome: 'failed', failure };
  }
}

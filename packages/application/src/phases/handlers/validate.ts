import { PhaseName, RunId } from '@ai-sdlc/domain';
import type { Failure, ValidationRun } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import type { RunValidation } from '../../run-validation.js';
import { validationRunToFailure } from '../../validation/validation-run-to-failure.js';

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

    let passed: boolean;
    let validationRun: ValidationRun;
    try {
      const result = await this.opts.runValidation.execute({
        runId: RunId(ctx.runUuid),
        phaseId: this.phase,
        cwd: ctx.cwd,
        logDir: this.opts.logDir,
        commands: this.opts.commands,
        timeoutSeconds: this.opts.timeoutSeconds,
      });
      passed = result.passed;
      validationRun = result.validationRun;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'validate',
        kind: 'unknown',
        message,
        canRetry: true,
        suggestedAction:
          'Check the validation phase configuration and ensure commands are defined.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      emit('phase.failed', 'error', message);
      return { outcome: 'failed', failure };
    }

    if (passed) {
      emit('phase.completed', 'info', 'validation passed', {
        commands: validationRun.commands.length,
      });
      return { outcome: 'passed' };
    }

    const failure = validationRunToFailure(validationRun, ctx.now())!;
    failure.suggestedAction =
      'Inspect the failing command logs under the validate phase, fix, and resume.';

    const failing = validationRun.commands
      .filter((c) => c.outcome !== 'passed')
      .map((c) => c.command);

    emit('phase.failed', 'error', failure.message, { failing });
    return { outcome: 'failed', failure };
  }
}

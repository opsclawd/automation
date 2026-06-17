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

    if (this.opts.commands.length === 0) {
      const message = 'no validation commands configured (validation.commands is empty)';
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'validate',
        kind: 'unknown',
        message,
        canRetry: false,
        suggestedAction: 'Add at least one command to validation.commands in the configuration.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      emit('phase.failed', 'error', message);
      return { outcome: 'failed', failure };
    }

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

    let failure = validationRunToFailure(validationRun, ctx.now());
    if (!failure) {
      failure = {
        runUuid: ctx.runUuid,
        phase: 'validate',
        kind: 'unknown',
        message: 'validation failed but could not determine the reason',
        canRetry: true,
        suggestedAction: 'Check the validation phase logs for details.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
    }

    const failing = validationRun.commands
      .filter((c) => c.outcome !== 'passed')
      .map((c) => c.command);

    emit('phase.failed', 'error', failure.message, { failing });
    return { outcome: 'failed', failure };
  }
}

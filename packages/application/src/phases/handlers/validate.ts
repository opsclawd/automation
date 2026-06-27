import { PhaseName, RunId } from '@ai-sdlc/domain';
import type { Failure } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import type { RunValidation } from '../../run-validation.js';

export interface ValidateHandlerOpts {
  runValidation: RunValidation;
  commands: string[];
  timeoutSeconds: number;
  logDir: string;
  /** When true, validation failures return 'deferred' so the pipeline continues
   * to fix-validate. When false, failures return 'failed' and stop the pipeline. */
  fixValidateEnabled: boolean;
}

export class ValidateHandler implements PhaseHandler {
  readonly phase = PhaseName('validate');

  constructor(private readonly opts: ValidateHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('validate.started', 'info', 'validate started');

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
      emit('validate.failed', 'error', message);
      return { outcome: 'failed', failure };
    }

    let passed: boolean;
    let failure: Failure | undefined;
    let validationRunLength: number | undefined;
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
      failure = result.failure;
      validationRunLength = result.validationRun.commands.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failure = {
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
      emit('validate.failed', 'error', message);
      return { outcome: 'failed', failure };
    }

    if (passed) {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: 'validate',
        relativePath: 'validation.result',
        contents: 'passed\n',
      });
      emit('validate.completed', 'info', 'validation passed', {
        commands: validationRunLength,
      });
      return { outcome: 'passed' };
    }

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

    try {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: 'validate',
        relativePath: 'validate/failure.json',
        contents: JSON.stringify(failure, null, 2),
      });
    } catch {
      emit('validate.artifact_write_failed', 'warn', 'failed to write failure.json artifact');
    }
    if (this.opts.fixValidateEnabled) {
      emit('validate.deferred', 'warn', failure.message);
      return { outcome: 'deferred' };
    }
    emit('validate.failed', 'error', failure.message);
    return { outcome: 'failed', failure };
  }
}

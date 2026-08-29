import { PhaseName, RunId } from '@ai-sdlc/domain';
import type { Failure } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import type { RunValidation } from '../../run-validation.js';
import {
  uncommittedSourcePaths,
  formatDirtyPaths,
} from '../../artifacts/orchestrator-artifacts.js';
import { normalizeTaskPath } from '../../task-file-boundaries.js';
import { recordValidationEvidence } from '../validation-evidence.js';

export function formatValidationBlockedMessage(
  dirtyPaths: readonly string[],
  report?: { steps?: Array<{ stepIndex: number; totalSteps?: number; files: string[] }> },
): string {
  if (!report?.steps || report.steps.length === 0) {
    return `Validation blocked by uncommitted source changes: ${formatDirtyPaths(dirtyPaths)}`;
  }

  const pathToStepIndex = new Map<string, number>();
  for (const stepRecord of report.steps) {
    for (const file of stepRecord.files) {
      const norm = normalizeTaskPath(file);
      pathToStepIndex.set(norm, stepRecord.stepIndex);
    }
  }

  const stepAttributions = dirtyPaths.map((p) => pathToStepIndex.get(normalizeTaskPath(p)));
  const uniqueSteps = [...new Set(stepAttributions.filter((s): s is number => s !== undefined))];

  if (uniqueSteps.length === 1 && stepAttributions.every((s) => s === uniqueSteps[0])) {
    const stepNum = uniqueSteps[0];
    return `Validation blocked by uncommitted source changes (reported by step ${stepNum}): ${formatDirtyPaths(dirtyPaths)}`;
  }

  if (uniqueSteps.length > 0) {
    const formattedWithSteps = dirtyPaths.map((p) => {
      const stepNum = pathToStepIndex.get(normalizeTaskPath(p));
      return stepNum !== undefined ? `${p} (reported by step ${stepNum})` : p;
    });
    return `Validation blocked by uncommitted source changes: ${formatDirtyPaths(formattedWithSteps)}`;
  }

  return `Validation blocked by uncommitted source changes: ${formatDirtyPaths(dirtyPaths)}`;
}

export interface ValidateHandlerOpts {
  runValidation: RunValidation;
  commands: string[];
  tiers?: string[][];
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

    let statusOutput: string;
    try {
      statusOutput = await ctx.git.status(ctx.cwd);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'validate',
        kind: 'git_failed',
        message: `failed to inspect git status: ${message}`,
        canRetry: false,
        suggestedAction: 'Check git repository state and permissions.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      emit('validate.failed', 'error', failure.message);
      return { outcome: 'failed', failure };
    }

    const isLeanPolicy = ctx.executionPolicy === 'standard' || ctx.executionPolicy === 'strict';
    const dirtyPaths = uncommittedSourcePaths(statusOutput);
    if (!isLeanPolicy && dirtyPaths.length > 0) {
      let scratchReport:
        | { steps?: Array<{ stepIndex: number; totalSteps?: number; files: string[] }> }
        | undefined;
      try {
        let scratchJson: string;
        try {
          scratchJson = await ctx.artifacts.read(ctx.runUuid, '.ai-tmp/scratch-files.json');
        } catch {
          scratchJson = await ctx.artifacts.read(ctx.runUuid, 'scratch-files.json');
        }
        scratchReport = JSON.parse(scratchJson);
      } catch {
        // Artifact may not exist
      }

      const message = formatValidationBlockedMessage(dirtyPaths, scratchReport);
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'validate',
        kind: 'git_failed',
        message,
        canRetry: false,
        suggestedAction:
          'Return to implementation and commit or discard the listed source changes.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      emit('validate.failed', 'error', message, { paths: dirtyPaths });
      return { outcome: 'failed', failure };
    }

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
        ...(this.opts.tiers ? { tiers: this.opts.tiers } : {}),
        timeoutSeconds: this.opts.timeoutSeconds,
        env: {
          GITHUB_REPOSITORY: ctx.repoFullName,
        },
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
      await recordValidationEvidence(ctx, 'validate');
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

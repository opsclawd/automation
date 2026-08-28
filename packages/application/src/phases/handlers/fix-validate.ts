import { PhaseName, AgentProfileName, type Failure } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { ArtifactNotFoundError } from '../../ports/artifact-store.js';
import { recordValidationHeadSha } from '../validation-headsha.js';
import { runSingleShotAgentPhase } from './run-single-shot-agent-phase.js';
import { loadPromptTemplate } from '../../prompts/load-prompt-template.js';

export interface FixValidateHandlerOpts {
  runLoop?: (ctx: PhaseHandlerContext) => Promise<{
    phaseOutcome: 'passed' | 'failed';
    loopStatus: 'converged' | 'failed' | 'exhausted';
  }>;
  profileName?: string;
}

export class FixValidateHandler implements PhaseHandler {
  readonly phase = 'fix-validate' as PhaseName;
  constructor(private readonly opts: FixValidateHandlerOpts = {}) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const isLeanPolicy = ctx.executionPolicy === 'standard' || ctx.executionPolicy === 'strict';
    if (isLeanPolicy || !this.opts.runLoop) {
      return this.runLean(ctx);
    }

    return this.runLegacy(ctx);
  }

  private async runLean(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);

    // fix-validate is only needed when validate wrote validate/failure.json
    let failureJson = '';
    try {
      failureJson = await ctx.artifacts.read(ctx.runUuid, 'validate/failure.json');
    } catch (e) {
      if (e instanceof ArtifactNotFoundError) {
        emit('fix_validate.skipped', 'info', 'fix-validate skipped — validation already passed');
        return { outcome: 'passed' };
      }
    }

    emit('fix_validate.started', 'info', 'fix-validate started (bounded 1-attempt repair)', {
      policy: ctx.executionPolicy,
    });

    const profile =
      ctx.resolveProfile?.('fix-validate') ??
      ctx.resolveProfile?.('fix-review') ??
      ctx.resolveProfile?.('implement') ??
      AgentProfileName(this.opts.profileName ?? 'opencode-frontier');

    let template: string | undefined;
    if (ctx.promptsRoot) {
      try {
        template = loadPromptTemplate('fix-validate', 'fix-validate', {
          promptsRoot: ctx.promptsRoot,
        });
      } catch {
        // Handled in runSingleShotAgentPhase
      }
    }

    const runResult = await runSingleShotAgentPhase(ctx, {
      phase: this.phase,
      profile,
      step: 'fix-validate',
      ...(template ? { template } : {}),
      vars: {
        issue_number: String(ctx.issueNumber),
        cwd: ctx.cwd,
        validation_failures: failureJson || 'Deterministic validation failed.',
      },
      agentContract: {
        requiredArtifacts: [],
        mustNotChangeBranch: true,
        mustNotCreateCommit: true,
      },
      skipResultExtraction: true,
    });

    if (runResult.outcome !== 'passed') {
      emit('fix_validate.failed', 'error', 'fix-validate agent failed');
      return {
        outcome: 'needs_human_review',
        failure: {
          runUuid: ctx.runUuid,
          phase: 'fix-validate',
          kind: 'needs_human_review',
          message: 'fix-validate agent failed to repair deterministic validation',
          canRetry: true,
          suggestedAction: 'Inspect validation failure and repair manually.',
          artifacts: ['validate/failure.json'],
          detectedAt: ctx.now(),
        },
      };
    }

    emit('fix_validate.completed', 'info', 'fix-validate repair attempt completed', {
      policy: ctx.executionPolicy,
    });
    return { outcome: 'passed' };
  }

  private async runLegacy(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);

    try {
      await ctx.artifacts.read(ctx.runUuid, 'validate/failure.json');
    } catch (e) {
      if (e instanceof ArtifactNotFoundError) {
        emit('fix_validate.skipped', 'info', 'fix-validate skipped — validation already passed');
        return { outcome: 'passed' };
      }
    }

    emit('fix_validate.started', 'info', 'fix-validate started');

    try {
      const result = await this.opts.runLoop!(ctx);
      if (result.phaseOutcome === 'passed') {
        await recordValidationHeadSha(ctx, 'fix-validate');
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

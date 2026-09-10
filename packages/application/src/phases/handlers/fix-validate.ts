import { PhaseName, AgentProfileName, type Failure } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { ArtifactNotFoundError, type ArtifactStore } from '../../ports/artifact-store.js';
import { recordValidationHeadSha, invalidateValidationEvidence } from '../validation-evidence.js';
import { runSingleShotAgentPhase } from './run-single-shot-agent-phase.js';
import { loadPromptTemplate } from '../../prompts/load-prompt-template.js';
import { formatValidationFailures } from './format-validation-failures.js';
import {
  parseStatusPaths,
  recordValidationCriticalFilesFromWorktree,
} from '../../review-fix/validation-critical-files.js';

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
    const isLeanPolicy =
      ctx.executionPolicy === 'standard' ||
      ctx.executionPolicy === 'strict' ||
      ctx.executionPolicy === 'legacy';
    if (isLeanPolicy || !this.opts.runLoop) {
      return this.runLean(ctx);
    }

    return this.runLegacy(ctx);
  }

  private async snapshotDirtyBefore(
    ctx: PhaseHandlerContext,
  ): Promise<Map<string, string | undefined>> {
    const dirtyBefore = new Map<string, string | undefined>();
    if (!ctx.git) {
      return dirtyBefore;
    }
    try {
      const statusOutput = await ctx.git.status(ctx.cwd);
      const dirtyPaths = parseStatusPaths(statusOutput, ctx.cwd);
      for (const p of dirtyPaths) {
        try {
          const content = await ctx.git.worktreeFileContent(ctx.cwd, p);
          dirtyBefore.set(p, content);
        } catch {
          dirtyBefore.set(p, undefined);
        }
      }
    } catch {
      // best-effort snapshot
    }
    return dirtyBefore;
  }

  private async extractValidationDiagnostic(
    artifacts: ArtifactStore,
    runUuid: string,
    failureJson: string,
    validationFailures: string,
  ): Promise<string> {
    try {
      const raw = await artifacts.read(runUuid, 'validate/validation-result.json');
      const parsed = JSON.parse(raw);
      const commands = Array.isArray(parsed?.commands) ? parsed.commands : [];
      const failed = commands
        .filter(
          (c: { outcome?: string; command?: string }) =>
            c.outcome === 'failed' || c.outcome === 'timed_out' || c.outcome === 'parse_error',
        )
        .map((c: { command?: string }) => (typeof c.command === 'string' ? c.command.trim() : ''))
        .filter(Boolean);
      if (failed.length > 0) {
        return failed.join(', ').slice(0, 200);
      }
    } catch {
      // validate/validation-result.json not available
    }

    if (failureJson) {
      try {
        const parsed = JSON.parse(failureJson);
        if (typeof parsed?.message === 'string' && parsed.message.trim()) {
          const firstLine = parsed.message.split('\n')[0]!.trim();
          if (firstLine) {
            return firstLine.slice(0, 200);
          }
        }
      } catch {
        // parse error
      }
    }

    return (validationFailures.split('\n')[0] || 'Deterministic validation failed.').slice(0, 200);
  }

  private async recordAndPersistCriticalFiles(
    ctx: PhaseHandlerContext,
    dirtyBefore: Map<string, string | undefined>,
    diagnostic: string,
  ): Promise<void> {
    if (!ctx.git) {
      return;
    }
    try {
      const criticalFiles = await recordValidationCriticalFilesFromWorktree({
        git: ctx.git,
        cwd: ctx.cwd,
        dirtyBefore,
        diagnostic,
      });

      if (criticalFiles.length > 0) {
        await ctx.artifacts.write({
          runId: ctx.runUuid,
          phaseId: this.phase,
          relativePath: 'validate/critical-files.json',
          contents: JSON.stringify(criticalFiles, null, 2),
        });
      } else {
        // Ensure an empty current result cannot leave a stale prior artifact visible
        try {
          await ctx.artifacts.read(ctx.runUuid, 'validate/critical-files.json');
          await ctx.artifacts.write({
            runId: ctx.runUuid,
            phaseId: this.phase,
            relativePath: 'validate/critical-files.json',
            contents: JSON.stringify([], null, 2),
          });
        } catch {
          // No prior artifact to clear, skip write
        }
      }
    } catch (err: unknown) {
      createEventEmitter(ctx, this.phase)(
        'fix_validate.critical_files_recording_failed',
        'warn',
        `failed to record validation-critical files: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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

    // Invalidate prior validation evidence before the repair Agent Invocation starts
    await invalidateValidationEvidence(ctx, this.phase);

    // Snapshot dirty files before repair attempt
    const dirtyBefore = await this.snapshotDirtyBefore(ctx);

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

    const validationFailures = failureJson
      ? await formatValidationFailures(failureJson, ctx.artifacts, ctx.runUuid)
      : 'Deterministic validation failed.';

    const runResult = await runSingleShotAgentPhase(ctx, {
      phase: this.phase,
      profile,
      step: 'fix-validate',
      ...(template ? { template } : {}),
      vars: {
        issue_number: String(ctx.issueNumber),
        cwd: ctx.cwd,
        validation_failures: validationFailures || 'Deterministic validation failed.',
      },
      agentContract: {
        requiredArtifacts: [],
        mustNotChangeBranch: true,
        mustNotCreateCommit: true,
      },
      resultJsonPath: 'fix-validate-result.json',
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

    // Capture validation-critical files changed during this fix attempt and persist before completed event
    const diagnostic = await this.extractValidationDiagnostic(
      ctx.artifacts,
      ctx.runUuid,
      failureJson,
      validationFailures,
    );
    await this.recordAndPersistCriticalFiles(ctx, dirtyBefore, diagnostic);

    emit('fix_validate.completed', 'info', 'fix-validate repair attempt completed', {
      policy: ctx.executionPolicy,
    });
    return { outcome: 'passed' };
  }

  private async runLegacy(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);

    let failureJson = '';
    try {
      failureJson = await ctx.artifacts.read(ctx.runUuid, 'validate/failure.json');
    } catch (e) {
      if (e instanceof ArtifactNotFoundError) {
        emit('fix_validate.skipped', 'info', 'fix-validate skipped — validation already passed');
        return { outcome: 'passed' };
      }
    }

    emit('fix_validate.started', 'info', 'fix-validate started');

    const dirtyBefore = await this.snapshotDirtyBefore(ctx);

    try {
      const result = await this.opts.runLoop!(ctx);
      if (result.phaseOutcome === 'passed') {
        const diagnostic = await this.extractValidationDiagnostic(
          ctx.artifacts,
          ctx.runUuid,
          failureJson,
          'Deterministic validation failed.',
        );
        await this.recordAndPersistCriticalFiles(ctx, dirtyBefore, diagnostic);
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

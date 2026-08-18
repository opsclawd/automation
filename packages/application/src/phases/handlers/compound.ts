import { PhaseName } from '@ai-sdlc/domain';
import type { PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { SingleShotAgentHandler } from './single-shot-agent-handler.js';
import { checkTaskBoundaries, loadManifest } from '../../task-file-boundaries.js';
import { uncommittedSourcePaths } from '../../artifacts/orchestrator-artifacts.js';

export class CompoundHandler extends SingleShotAgentHandler {
  constructor() {
    super(PhaseName('compound'), 'compound', {
      skipResultExtraction: true,
      skipCompletedEmit: true,
    });
  }

  override async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);

    let headBefore: string;
    try {
      headBefore = await ctx.git.headCommitSha(ctx.cwd);
    } catch (err) {
      const message = `Failed to read baseline HEAD commit SHA in ${String(this.phase)} phase: ${err instanceof Error ? err.message : String(err)}`;
      emit(`${String(this.phase)}.failed`, 'error', message);
      return {
        outcome: 'failed',
        failure: {
          runUuid: ctx.runUuid,
          phase: this.phase,
          kind: 'git_failed',
          message,
          canRetry: false,
          suggestedAction: 'Check git repository status.',
          artifacts: [],
          detectedAt: ctx.now(),
        },
      };
    }

    const result = await super.run(ctx);
    if (result.outcome !== 'passed') {
      return result;
    }

    let headAfter: string;
    try {
      headAfter = await ctx.git.headCommitSha(ctx.cwd);
    } catch (err) {
      const message = `Failed to read post-run HEAD commit SHA in ${String(this.phase)} phase: ${err instanceof Error ? err.message : String(err)}`;
      emit(`${String(this.phase)}.failed`, 'error', message);
      return {
        outcome: 'failed',
        failure: {
          runUuid: ctx.runUuid,
          phase: this.phase,
          kind: 'git_failed',
          message,
          canRetry: false,
          suggestedAction: 'Check git repository status.',
          artifacts: [],
          detectedAt: ctx.now(),
        },
      };
    }

    let committedFiles: string[] = [];
    if (headBefore !== headAfter) {
      try {
        committedFiles = await ctx.git.changedFiles(ctx.cwd, headBefore, headAfter);
      } catch (err) {
        const message = `Failed to check changed files in ${String(this.phase)} phase: ${err instanceof Error ? err.message : String(err)}`;
        emit(`${String(this.phase)}.failed`, 'error', message);
        return {
          outcome: 'failed',
          failure: {
            runUuid: ctx.runUuid,
            phase: this.phase,
            kind: 'git_failed',
            message,
            canRetry: false,
            suggestedAction: 'Check git repository status.',
            artifacts: [],
            detectedAt: ctx.now(),
          },
        };
      }
    }

    let uncommittedFiles: string[] = [];
    try {
      const statusOutput = await ctx.git.status(ctx.cwd);
      uncommittedFiles = uncommittedSourcePaths(statusOutput);
    } catch (err) {
      const message = `Failed to check git status in ${String(this.phase)} phase: ${err instanceof Error ? err.message : String(err)}`;
      emit(`${String(this.phase)}.failed`, 'error', message);
      return {
        outcome: 'failed',
        failure: {
          runUuid: ctx.runUuid,
          phase: this.phase,
          kind: 'git_failed',
          message,
          canRetry: false,
          suggestedAction: 'Check git repository status.',
          artifacts: [],
          detectedAt: ctx.now(),
        },
      };
    }

    const changedFiles = [...new Set([...committedFiles, ...uncommittedFiles])];
    if (changedFiles.length > 0) {
      const manifestResult = await loadManifest(
        { runId: ctx.runUuid },
        { cwd: ctx.cwd, runId: ctx.runUuid },
        {
          artifactStore: ctx.artifacts,
          readWorktreeFile: ctx.readWorktreeFile,
        },
      );

      if (manifestResult.status === 'missing' || manifestResult.status === 'malformed') {
        const message = `Could not read or parse task-manifest.json for boundary enforcement: ${manifestResult.message}`;
        emit(`${String(this.phase)}.failed`, 'error', message);
        return {
          outcome: 'failed',
          failure: {
            runUuid: ctx.runUuid,
            phase: this.phase,
            kind: 'validation_failed',
            message,
            canRetry: false,
            suggestedAction: 'Ensure task-manifest.json exists and is valid JSON.',
            artifacts: ['task-manifest.json'],
            detectedAt: ctx.now(),
          },
        };
      }

      const classification = checkTaskBoundaries(changedFiles, manifestResult.manifest);
      const violatingFiles = [
        ...classification.modifiedReferenceFiles,
        ...classification.undeclaredFiles,
      ];
      if (violatingFiles.length > 0) {
        const message = `${String(this.phase)} phase modified undeclared files: ${violatingFiles.join(', ')}`;
        emit(`${String(this.phase)}.boundary_violation`, 'error', message, {
          phase: this.phase,
          files: violatingFiles,
          modifiedReferenceFiles: classification.modifiedReferenceFiles,
          undeclaredFiles: classification.undeclaredFiles,
        });
        emit(`${String(this.phase)}.failed`, 'error', message);
        return {
          outcome: 'failed',
          failure: {
            runUuid: ctx.runUuid,
            phase: this.phase,
            kind: 'validation_failed',
            message,
            canRetry: false,
            suggestedAction: `Ensure ${String(this.phase)} phase does not modify undeclared repository files.`,
            artifacts: ['task-manifest.json'],
            detectedAt: ctx.now(),
          },
        };
      }
    }

    emit(`${String(this.phase)}.completed`, 'info', `${String(this.phase)} completed`);
    return result;
  }
}

import { PhaseName } from '@ai-sdlc/domain';
import type { PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { SingleShotAgentHandler } from './single-shot-agent-handler.js';
import {
  checkTaskBoundaries,
  getManifestBoundaries,
  loadManifest,
  normalizedPathSet,
} from '../../task-file-boundaries.js';
import { uncommittedSourcePaths } from '../../artifacts/orchestrator-artifacts.js';
import { remediateScratchFiles } from '../../scratch-file-remediation.js';

export interface CompoundHandlerOpts {
  exemptUndeclaredFiles?: string[];
}

export class CompoundHandler extends SingleShotAgentHandler {
  constructor(private readonly opts?: CompoundHandlerOpts) {
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
    let statusOutput = '';
    try {
      statusOutput = await ctx.git.status(ctx.cwd);
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

    const changedFilesBeforeRemediation = [...new Set([...committedFiles, ...uncommittedFiles])];
    if (changedFilesBeforeRemediation.length > 0) {
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

      const { writableSet, referenceSet } = getManifestBoundaries(manifestResult.manifest);
      const exemptSet = normalizedPathSet(this.opts?.exemptUndeclaredFiles);

      try {
        const remediation = await remediateScratchFiles({
          cwd: ctx.cwd,
          runUuid: ctx.runUuid,
          status: statusOutput,
          writableFiles: writableSet,
          referenceFiles: referenceSet,
          exemptFiles: exemptSet,
          artifacts: ctx.artifacts,
          deleteWorktreeFile: ctx.deleteWorktreeFile,
          emit,
          phase: String(this.phase),
          stepIndex: 0,
          totalSteps: 1,
          stepTitle: String(this.phase),
        });

        if (remediation.remediated) {
          statusOutput = await ctx.git.status(ctx.cwd);
          uncommittedFiles = uncommittedSourcePaths(statusOutput);
        }
      } catch {
        // Remediation is best-effort; continue to boundary checking
      }

      const changedFiles = [...new Set([...committedFiles, ...uncommittedFiles])];
      if (changedFiles.length > 0) {
        const classification = checkTaskBoundaries(
          changedFiles,
          manifestResult.manifest,
          this.opts?.exemptUndeclaredFiles,
        );
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
    }

    emit(`${String(this.phase)}.completed`, 'info', `${String(this.phase)} completed`);
    return result;
  }
}

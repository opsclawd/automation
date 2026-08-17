import { PhaseName } from '@ai-sdlc/domain';
import type { PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { SingleShotAgentHandler } from './single-shot-agent-handler.js';
import { checkTaskBoundaries } from '../../task-file-boundaries.js';

export class CompoundHandler extends SingleShotAgentHandler {
  constructor() {
    super(PhaseName('compound'), 'compound', {
      skipResultExtraction: true,
      skipCompletedEmit: true,
    });
  }

  override async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    const headBefore = await ctx.git.headCommitSha(ctx.cwd).catch(() => undefined);

    const result = await super.run(ctx);
    if (result.outcome !== 'passed') {
      return result;
    }

    const headAfter = await ctx.git.headCommitSha(ctx.cwd).catch(() => undefined);
    if (headBefore && headAfter && headBefore !== headAfter) {
      let committedFiles: string[] = [];
      try {
        committedFiles = await ctx.git.changedFiles(ctx.cwd, headBefore, headAfter);
      } catch (err) {
        const message = `Failed to check changed files in compound phase: ${err instanceof Error ? err.message : String(err)}`;
        emit('compound.failed', 'error', message);
        return {
          outcome: 'failed',
          failure: {
            runUuid: ctx.runUuid,
            phase: 'compound',
            kind: 'git_failed',
            message,
            canRetry: false,
            suggestedAction: 'Check git repository status.',
            artifacts: [],
            detectedAt: ctx.now(),
          },
        };
      }

      let manifest: unknown;
      try {
        const manifestRaw = await ctx.artifacts.read(ctx.runUuid, 'task-manifest.json');
        manifest = JSON.parse(manifestRaw);
      } catch {
        // manifest not available or not valid JSON — skip boundary enforcement
      }

      if (manifest) {
        const classification = checkTaskBoundaries(committedFiles, manifest);
        const violatingFiles = [
          ...classification.modifiedReferenceFiles,
          ...classification.undeclaredFiles,
        ];
        if (violatingFiles.length > 0) {
          const message = `compound phase modified undeclared files: ${violatingFiles.join(', ')}`;
          emit('compound.boundary_violation', 'error', message, {
            phase: 'compound',
            files: violatingFiles,
            modifiedReferenceFiles: classification.modifiedReferenceFiles,
            undeclaredFiles: classification.undeclaredFiles,
          });
          emit('compound.failed', 'error', message);
          return {
            outcome: 'failed',
            failure: {
              runUuid: ctx.runUuid,
              phase: 'compound',
              kind: 'validation_failed',
              message,
              canRetry: false,
              suggestedAction: 'Ensure compound phase does not modify undeclared repository files.',
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

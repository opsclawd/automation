import { PhaseName } from '@ai-sdlc/domain';
import type { Failure } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import type { GitHubIssue } from '../../ports/github-port.js';
import { createEventEmitter } from '../handler.js';

export class ReadIssueHandler implements PhaseHandler {
  readonly phase = PhaseName('read_issue');

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('read_issue.started', 'info', 'reading issue');

    let issue: GitHubIssue;
    try {
      issue = await ctx.github.getIssue(ctx.repoFullName, ctx.issueNumber);
    } catch (e) {
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'read_issue',
        kind: 'github_failed',
        message: `Failed to fetch issue #${ctx.issueNumber}: ${e instanceof Error ? e.message : String(e)}`,
        canRetry: true,
        suggestedAction: 'Check gh auth and network, then retry.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      emit('read_issue.failed', 'error', failure.message);
      return { outcome: 'failed', failure };
    }

    if (issue.labels.includes('ai:blocked')) {
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'read_issue',
        kind: 'agent_blocked',
        message: `Issue #${ctx.issueNumber} has the ai:blocked label`,
        canRetry: false,
        suggestedAction: 'Remove the ai:blocked label from the issue, then retry the run.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      emit('read_issue.blocked', 'error', failure.message);
      return { outcome: 'blocked', failure };
    }

    const issueMd = issue.body ? `# ${issue.title}\n\n${issue.body}\n` : `# ${issue.title}\n`;

    let result = await this.writeArtifact(ctx, emit, 'issue-comments.md', '');
    if (result) return result;

    result = await this.writeArtifact(ctx, emit, 'issue.md', issueMd);
    if (result) return result;

    emit('read_issue.completed', 'info', 'read issue complete');
    return { outcome: 'passed' };
  }

  private async writeArtifact(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
    filename: string,
    contents: string,
  ): Promise<PhaseResult | null> {
    try {
      await ctx.artifacts.write({
        runId: ctx.runUuid, // artifact store uses runUuid as partition key
        phaseId: 'read_issue',
        relativePath: filename,
        contents,
      });
    } catch (e) {
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'read_issue',
        kind: 'unknown',
        message: `Failed to write ${filename}: ${e instanceof Error ? e.message : String(e)}`,
        canRetry: true,
        suggestedAction: 'Check disk space and permissions, then retry.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      emit('read_issue.failed', 'error', failure.message);
      return { outcome: 'failed', failure };
    }
    emit('artifact.created', 'info', `wrote ${filename}`, { path: filename });
    return null;
  }
}

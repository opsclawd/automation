import { PhaseName } from '@ai-sdlc/domain';
import type { Failure } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';

export class ReadIssueHandler implements PhaseHandler {
  readonly phase = PhaseName('read_issue');

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    this.emit(ctx, 'phase.started', 'info', 'reading issue');

    let issue;
    try {
      issue = await ctx.github.getIssue(ctx.repoFullName, ctx.issueNumber);
    } catch (e) {
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'read_issue',
        kind: 'github_failed',
        message: `Failed to fetch issue #${ctx.issueNumber}: ${(e as Error).message}`,
        canRetry: true,
        suggestedAction: 'Check gh auth and network, then retry.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      this.emit(ctx, 'phase.failed', 'error', failure.message);
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
      this.emit(ctx, 'phase.failed', 'error', failure.message);
      return { outcome: 'blocked', failure };
    }

    const issueMd = `# ${issue.title}\n\n${issue.body}\n`;
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: issueMd,
    });
    this.emit(ctx, 'artifact.created', 'info', 'wrote issue.md', { path: 'issue.md' });

    // TODO: add GitHubPort.listIssueComments and populate this. Empty for now.
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'read_issue',
      relativePath: 'issue-comments.md',
      contents: '',
    });
    this.emit(ctx, 'artifact.created', 'info', 'wrote issue-comments.md', {
      path: 'issue-comments.md',
    });

    this.emit(ctx, 'phase.completed', 'info', 'read issue complete');
    return { outcome: 'passed' };
  }

  private emit(
    ctx: PhaseHandlerContext,
    type: string,
    level: 'info' | 'warn' | 'error',
    message: string,
    metadata: Record<string, unknown> = {},
  ): void {
    ctx.events.publish(ctx.runUuid, {
      runId: ctx.runUuid,
      phase: 'read_issue',
      level,
      type,
      message,
      timestamp: ctx.now().toISOString(),
      metadata,
    });
  }
}

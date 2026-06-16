import { PhaseName } from '@ai-sdlc/domain';
import type { Failure } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';

export class ReadIssueHandler implements PhaseHandler {
  readonly phase = PhaseName('read_issue');

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('phase.started', 'info', 'reading issue');

    let issue;
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
      emit('phase.failed', 'error', failure.message);
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
      emit('phase.blocked', 'error', failure.message);
      return { outcome: 'blocked', failure };
    }

    const issueMd = issue.body ? `# ${issue.title}\n\n${issue.body}\n` : `# ${issue.title}\n`;
    try {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: 'read_issue',
        relativePath: 'issue.md',
        contents: issueMd,
      });
    } catch (e) {
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'read_issue',
        kind: 'unknown',
        message: `Failed to write issue.md: ${e instanceof Error ? e.message : String(e)}`,
        canRetry: true,
        suggestedAction: 'Check disk space and permissions, then retry.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      emit('phase.failed', 'error', failure.message);
      return { outcome: 'failed', failure };
    }
    emit('artifact.created', 'info', 'wrote issue.md', { path: 'issue.md' });

    // TODO: add GitHubPort.listIssueComments and populate this. Empty for now.
    try {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: 'read_issue',
        relativePath: 'issue-comments.md',
        contents: '',
      });
    } catch (e) {
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'read_issue',
        kind: 'unknown',
        message: `Failed to write issue-comments.md: ${e instanceof Error ? e.message : String(e)}`,
        canRetry: true,
        suggestedAction: 'Check disk space and permissions, then retry.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      emit('phase.failed', 'error', failure.message);
      return { outcome: 'failed', failure };
    }
    emit('artifact.created', 'info', 'wrote issue-comments.md', {
      path: 'issue-comments.md',
    });

    emit('phase.completed', 'info', 'read issue complete');
    return { outcome: 'passed' };
  }
}

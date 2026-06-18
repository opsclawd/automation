import type { PhaseName, Failure } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { getPhaseDefinition } from '../phase-definitions.js';
import { runSingleShotAgentPhase } from './run-single-shot-agent-phase.js';

export interface CreatePrHandlerOpts {
  baseBranch: string;
  headBranch: string;
  /** Optional explicit prompt template. Tests inject this to avoid filesystem.
   *  In production (M8-10), loadPromptTemplate loads from disk via compose root. */
  template?: string;
}

export class CreatePrHandler implements PhaseHandler {
  readonly phase = 'create-pr' as PhaseName;
  constructor(private readonly opts: CreatePrHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('phase.started', 'info', 'starting create-pr');

    // Guard: resolveProfile must be present
    if (!ctx.resolveProfile) {
      const msg = 'resolveProfile not available on context';
      emit('phase.failed', 'error', msg);
      return this._fail(
        ctx,
        'command_failed',
        msg,
        false,
        'Ensure the compose root provides resolveProfile.',
      );
    }

    const def = getPhaseDefinition(this.phase);
    const profile = ctx.resolveProfile(this.phase);
    if (!profile) {
      const msg = `resolveProfile returned empty for phase 'create-pr'`;
      emit('phase.failed', 'error', msg);
      return this._fail(
        ctx,
        'command_failed',
        msg,
        false,
        'Ensure the phase profile is configured.',
      );
    }

    // ── Stage 1: Agent drafts pr-summary.md ──
    const draft = await runSingleShotAgentPhase(ctx, {
      phase: this.phase,
      profile,
      step: 'create-pr',
      ...(this.opts.template !== undefined ? { template: this.opts.template } : {}),
      vars: { issue_number: String(ctx.issueNumber) },
      agentContract: def.agentContract!,
    });

    if (draft.outcome !== 'passed') return draft;

    // ── Stage 2: Deterministic GitHub operations ──

    // Read the summary the agent produced
    let summary: string;
    try {
      summary = await ctx.artifacts.read(ctx.runUuid, 'pr-summary.md');
    } catch {
      const msg = 'agent succeeded but pr-summary.md is missing';
      emit('phase.failed', 'error', msg);
      return this._fail(
        ctx,
        'missing_artifact',
        msg,
        false,
        'Check agent output. The contract requires pr-summary.md.',
      );
    }

    const title = _firstHeadingOrLine(summary, ctx.issueNumber);

    // Idempotency: if pr-url.txt already exists for this run, reuse it
    let prUrl: string | undefined;
    try {
      prUrl = (await ctx.artifacts.read(ctx.runUuid, 'pr-url.txt')).trim();
    } catch {
      prUrl = undefined;
    }

    if (!prUrl) {
      try {
        // TODO: GitHubPort.findOpenPrForBranch(repoFullName, headBranch) for cross-process idempotency.
        const pr = await ctx.github.createPullRequest({
          repoFullName: ctx.repoFullName,
          baseBranch: this.opts.baseBranch,
          headBranch: this.opts.headBranch,
          title,
          body: summary,
        });
        prUrl = pr.url;
        emit('pr.created', 'info', `opened PR ${pr.number}`, { number: pr.number, url: pr.url });
      } catch (e) {
        const msg = `failed to create PR: ${(e as Error).message}`;
        emit('phase.failed', 'error', msg);
        return this._fail(
          ctx,
          'github_failed',
          msg,
          true,
          'Check gh auth/branch state; resume create-pr.',
        );
      }
    } else {
      emit('pr.reused', 'info', `reusing existing PR url ${prUrl}`, { url: prUrl });
    }

    // Update issue labels (non-fatal on failure)
    // Sequenced before pr-url.txt write so label mutation is not gated
    // by artifact storage availability.
    try {
      await ctx.github.updateIssueLabels(ctx.repoFullName, ctx.issueNumber, {
        remove: ['ai:in-progress'],
        add: ['ai:pr-ready'],
      });
    } catch (e) {
      emit('github.label_update_failed', 'warn', `label update failed: ${(e as Error).message}`);
    }

    // Write pr-url.txt artifact. PR is already created on GitHub at this point;
    // retrying would produce a duplicate, so canRetry: false is required.
    try {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: 'create-pr',
        relativePath: 'pr-url.txt',
        contents: prUrl + '\n',
      });
    } catch (e) {
      const msg = `failed to write pr-url.txt: ${(e as Error).message}`;
      emit('phase.failed', 'error', msg);
      return this._fail(
        ctx,
        'command_failed',
        msg,
        false,
        `PR created at ${prUrl} but pr-url.txt write failed. Verify PR and record URL manually, then resume.`,
      );
    }

    emit('phase.completed', 'info', 'create-pr complete');
    return { outcome: 'passed' };
  }

  private _fail(
    ctx: PhaseHandlerContext,
    kind: Failure['kind'],
    message: string,
    canRetry: boolean,
    suggestedAction: string,
  ): PhaseResult {
    return {
      outcome: 'failed',
      failure: {
        runUuid: ctx.runUuid,
        phase: this.phase,
        kind,
        message,
        canRetry,
        suggestedAction,
        artifacts: ['pr-summary.md'],
        detectedAt: ctx.now(),
      },
    };
  }
}

function _firstHeadingOrLine(summary: string, issueNumber: number): string {
  const heading = summary.split('\n').find((l) => l.startsWith('#'));
  if (heading) return heading.replace(/^#+\s*/, '').trim();
  const firstLine = summary.split('\n').find((l) => l.trim().length > 0);
  return firstLine?.trim() ?? `Resolve issue #${issueNumber}`;
}

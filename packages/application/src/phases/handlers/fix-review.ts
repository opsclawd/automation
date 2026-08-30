import { PhaseName, AgentProfileName, type Failure, type FailureKind } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { runSingleShotAgentPhase } from './run-single-shot-agent-phase.js';
import { loadPromptTemplate } from '../../prompts/load-prompt-template.js';
import { formatLedgerForFixPrompt, type FindingLedger } from '../../review-fix/finding-ledger.js';
import { invalidateValidationEvidence } from '../validation-evidence.js';

export interface FixReviewHandlerOpts {
  profileName?: string;
}

export class FixReviewHandler implements PhaseHandler {
  readonly phase = PhaseName('fix-review');

  constructor(private readonly opts: FixReviewHandlerOpts = {}) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('fix_review.started', 'info', 'starting targeted review-fix pass', {
      policy: ctx.executionPolicy,
    });

    // 1. Read finding ledger or code-review.md
    let formattedFindings = '';
    try {
      const ledgerRaw = await ctx.artifacts.read(ctx.runUuid, 'finding-ledger.json');
      const ledger = JSON.parse(ledgerRaw) as FindingLedger;
      formattedFindings = formatLedgerForFixPrompt(ledger);
    } catch {
      try {
        const reviewMd = await ctx.artifacts.read(ctx.runUuid, 'code-review.md');
        formattedFindings = reviewMd;
      } catch {
        formattedFindings = 'Fix all review findings reported in code-review.md.';
      }
    }

    // 2. Resolve fix profile
    const fixProfile =
      ctx.resolveProfile?.('fix-review') ??
      ctx.resolveProfile?.('implement') ??
      AgentProfileName(this.opts.profileName ?? 'opencode-frontier');

    // 3. Load targeted fix template
    let fixTemplate: string | undefined;
    if (ctx.promptsRoot) {
      try {
        fixTemplate = loadPromptTemplate('review-fix', 'targeted-fix', {
          promptsRoot: ctx.promptsRoot,
        });
      } catch {
        // Handled in runSingleShotAgentPhase
      }
    }

    // 4. Run fixer agent invocation
    const fixRunResult = await runSingleShotAgentPhase(ctx, {
      phase: 'fix-review',
      profile: fixProfile,
      step: 'targeted-fix',
      ...(fixTemplate ? { template: fixTemplate } : {}),
      vars: {
        issue_number: String(ctx.issueNumber),
        cwd: ctx.cwd,
        review_findings: formattedFindings,
      },
      agentContract: {
        requiredArtifacts: [],
        mustNotChangeBranch: true,
        mustNotCreateCommit: true,
      },
      skipCompletedEmit: true,
    });

    if (fixRunResult.outcome !== 'passed') {
      emit('fix_review.failed', 'error', 'targeted fix agent failed');
      return fixRunResult;
    }

    // 5. Check result for cannot_fix verdict
    if (fixRunResult.result.result === 'cannot_fix') {
      const message = 'targeted fixer reported it cannot fix the review findings';
      emit('fix_review.failed', 'error', message);
      return {
        outcome: 'needs_human_review',
        failure: {
          runUuid: ctx.runUuid,
          phase: this.phase,
          kind: 'needs_human_review',
          message,
          canRetry: true,
          suggestedAction: 'Review the findings and intervene manually.',
          artifacts: ['code-review.md', 'finding-ledger.json'],
          detectedAt: ctx.now(),
        },
      };
    }

    await invalidateValidationEvidence(ctx, this.phase);

    emit('fix_review.completed', 'info', 'targeted review-fix pass completed', {
      policy: ctx.executionPolicy,
    });
    return { outcome: 'passed' };
  }

  private fail(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
    kind: FailureKind,
    message: string,
    suggestedAction?: string,
  ): PhaseResult {
    const failure: Failure = {
      runUuid: ctx.runUuid,
      phase: this.phase as string,
      kind,
      message,
      canRetry: true,
      suggestedAction: suggestedAction ?? 'Inspect fix logs and retry.',
      artifacts: [],
      detectedAt: ctx.now(),
    };
    emit('fix_review.failed', 'error', message);
    return { outcome: 'failed', failure };
  }
}

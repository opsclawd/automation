import { PhaseName, AgentProfileName, type Failure, type FailureKind } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { ArtifactNotFoundError } from '../../ports/artifact-store.js';
import { runSingleShotAgentPhase } from './run-single-shot-agent-phase.js';
import { loadPromptTemplate } from '../../prompts/load-prompt-template.js';
import {
  followUpReviewResultSchema,
  type FollowUpReviewResult,
} from '../../results/schemas/follow-up-review.js';
import {
  updateFindingLedger,
  formatLedgerForPrompt,
  hasUnresolvedBlockingFindings,
  type FindingLedger,
} from '../../review-fix/finding-ledger.js';

export interface FollowUpReviewHandlerOpts {
  profileName?: string;
  iterationIndex?: number;
}

export class FollowUpReviewHandler implements PhaseHandler {
  readonly phase = PhaseName('follow-up-review');

  constructor(private readonly opts: FollowUpReviewHandlerOpts = {}) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('follow_up_review.started', 'info', 'follow-up review started', {
      policy: ctx.executionPolicy,
    });

    // 1. Read finding ledger
    let ledger: FindingLedger;
    try {
      const ledgerRaw = await ctx.artifacts.read(ctx.runUuid, 'finding-ledger.json');
      ledger = JSON.parse(ledgerRaw) as FindingLedger;
    } catch {
      ledger = { version: 1, iterationCount: 0, entries: [] };
    }

    const currentIteration = (this.opts.iterationIndex ?? ledger.iterationCount) + 1;
    const formattedLedger = formatLedgerForPrompt(ledger);

    // 2. Validate issue truth is present
    try {
      await ctx.artifacts.read(ctx.runUuid, 'issue.md');
    } catch (e) {
      const message =
        e instanceof ArtifactNotFoundError
          ? 'issue.md not found in artifact store'
          : `Failed to read issue.md: ${e instanceof Error ? e.message : String(e)}`;
      return this.fail(ctx, emit, 'missing_artifact', message);
    }

    // 3. Collect complete branch diff and fix delta
    const baseBranch = ctx.expectedBranch ?? ctx.baseBranch ?? 'main';
    let completeDiff = '';
    let fixDiff = '';
    try {
      if (ctx.git?.diff) {
        completeDiff = await ctx.git.diff(ctx.cwd, ctx.startCommitSha ?? baseBranch);
        const priorHeadSha = await ctx.artifacts
          .read(ctx.runUuid, 'review-head-sha.txt')
          .catch(() => undefined);
        if (priorHeadSha?.trim()) {
          fixDiff = await ctx.git.diff(ctx.cwd, priorHeadSha.trim());
        } else {
          fixDiff = completeDiff;
        }
      }
    } catch {
      completeDiff = '';
      fixDiff = '';
    }

    // 4. Collect validation evidence
    let validationEvidence = 'Validation Status: passed';
    try {
      const valResult = await ctx.artifacts.read(ctx.runUuid, 'validation.result');
      validationEvidence = `Validation result: ${valResult.trim()}`;
    } catch {
      // Best-effort
    }

    // 5. Resolve reviewer profile
    if (!ctx.resolveProfile) {
      return this.fail(ctx, emit, 'command_failed', 'resolveProfile not available on context');
    }
    const resolve = (p: string) => {
      try {
        return ctx.resolveProfile?.(p);
      } catch {
        return undefined;
      }
    };
    const profile =
      resolve('follow-up-review') ??
      resolve('initial-review') ??
      resolve('whole-pr-review') ??
      resolve('implement') ??
      AgentProfileName(this.opts.profileName ?? 'opencode-frontier');

    // 6. Load prompt template
    let template: string | undefined;
    if (ctx.promptsRoot) {
      try {
        template = loadPromptTemplate('review-fix', 'follow-up-review', {
          promptsRoot: ctx.promptsRoot,
        });
      } catch {
        // Handled in runSingleShotAgentPhase
      }
    }

    // 7. Invoke single-shot follow-up reviewer agent (read-only)
    const runResult = await runSingleShotAgentPhase(ctx, {
      phase: this.phase,
      profile,
      step: 'follow-up-review',
      ...(template ? { template } : {}),
      vars: {
        issue_number: String(ctx.issueNumber),
        cwd: ctx.cwd,
        finding_ledger: formattedLedger,
        validation_evidence: validationEvidence,
        complete_diff: completeDiff || '(no diff)',
        fix_diff: fixDiff || '(no diff)',
      },
      agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
      skipResultExtraction: true,
    });

    if (runResult.outcome !== 'passed') {
      emit('follow_up_review.failed', 'error', 'follow-up reviewer invocation failed');
      return runResult;
    }

    // 8. Extract and validate structured result.json
    let parsedResult: FollowUpReviewResult;
    try {
      const resultRaw = await ctx.artifacts.read(ctx.runUuid, 'result.json');
      const parsed = JSON.parse(resultRaw);
      const val = followUpReviewResultSchema.safeParse(parsed);
      if (!val.success) {
        return this.fail(
          ctx,
          emit,
          'invalid_result',
          `Failed to validate follow-up review schema: ${val.error.message}`,
        );
      }
      parsedResult = val.data;
    } catch (err) {
      return this.fail(
        ctx,
        emit,
        'invalid_result',
        `Failed to parse follow-up review result.json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 9. Update finding ledger
    const updatedLedger = updateFindingLedger(
      ledger,
      parsedResult.evaluations,
      parsedResult.new_findings,
      currentIteration,
    );

    const hasUnresolved = hasUnresolvedBlockingFindings(updatedLedger);
    const effectiveVerdict =
      parsedResult.verdict.toUpperCase() === 'APPROVE' && !hasUnresolved
        ? 'APPROVE'
        : 'REQUEST_CHANGES';

    // Update parsedResult so persisted artifact reflects the effective verdict
    parsedResult.verdict = effectiveVerdict;

    // Persist updated artifacts
    const formattedReviewMd = this.formatFollowUpMarkdown(parsedResult, updatedLedger);
    try {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'code-review.md',
        contents: formattedReviewMd,
      });
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'follow-up-review.json',
        contents: JSON.stringify(parsedResult, null, 2),
      });
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'finding-ledger.json',
        contents: JSON.stringify(updatedLedger, null, 2),
      });

      const currentHeadSha = await ctx.git?.headCommitSha(ctx.cwd).catch(() => undefined);
      if (currentHeadSha?.trim()) {
        await ctx.artifacts.write({
          runId: ctx.runUuid,
          phaseId: this.phase,
          relativePath: 'review-head-sha.txt',
          contents: currentHeadSha.trim(),
        });
      }
    } catch (writeErr) {
      return this.fail(
        ctx,
        emit,
        'command_failed',
        `Failed to persist follow-up review artifacts: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        'Ensure artifact storage directory is writable.',
      );
    }

    if (effectiveVerdict === 'APPROVE') {
      emit('follow_up_review.completed', 'info', 'follow-up review approved', {
        policy: ctx.executionPolicy,
        verdict: 'APPROVE',
        iteration: currentIteration,
      });
      return { outcome: 'passed' };
    }

    emit('follow_up_review.changes_requested', 'warn', 'follow-up review requested changes', {
      policy: ctx.executionPolicy,
      verdict: 'REQUEST_CHANGES',
      iteration: currentIteration,
      unresolvedCount: updatedLedger.entries.filter((e) => e.status === 'unresolved').length,
    });
    emit(
      'follow_up_review.completed',
      'info',
      'follow-up review completed with changes requested',
      { iteration: currentIteration },
    );
    return { outcome: 'passed' };
  }

  private formatFollowUpMarkdown(review: FollowUpReviewResult, _ledger: FindingLedger): string {
    const lines: string[] = [
      '# Follow-Up Review',
      '',
      `**Verdict:** ${review.verdict}`,
      ...(review.summary ? [`**Summary:** ${review.summary}`, ''] : ['']),
      '## Prior Findings Evaluations',
      '',
    ];

    if (review.evaluations.length === 0) {
      lines.push('No prior evaluations recorded.');
    } else {
      for (const ev of review.evaluations) {
        lines.push(`### [${ev.resolved ? 'RESOLVED' : 'UNRESOLVED'}] ${ev.finding_id}`);
        lines.push(`- **Evidence:** ${ev.evidence}`);
        if (ev.rationale) {
          lines.push(`- **Rationale:** ${ev.rationale}`);
        }
        lines.push('');
      }
    }

    lines.push('## New Findings / Regressions', '');
    if (!review.new_findings || review.new_findings.length === 0) {
      lines.push('No new findings or regressions detected.');
    } else {
      for (const f of review.new_findings) {
        lines.push(`### [${f.severity.toUpperCase()}] New Finding`);
        if (f.files && f.files.length > 0) {
          lines.push(`- **Files:** ${f.files.join(', ')}`);
        }
        lines.push(`- **Evidence:** ${f.evidence}`);
        lines.push(`- **Rationale:** ${f.rationale}`);
        lines.push(`- **Minimal Correction:** ${f.minimal_correction}`);
        lines.push('');
      }
    }

    return lines.join('\n');
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
      canRetry: kind !== 'invalid_result',
      suggestedAction: suggestedAction ?? 'Inspect follow-up review logs and retry.',
      artifacts: [],
      detectedAt: ctx.now(),
    };
    emit('follow_up_review.failed', 'error', message);
    return { outcome: 'failed', failure };
  }
}

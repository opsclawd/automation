import { PhaseName, AgentProfileName, type Failure, type FailureKind } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { ArtifactNotFoundError } from '../../ports/artifact-store.js';
import { runSingleShotAgentPhase } from './run-single-shot-agent-phase.js';
import { loadPromptTemplate } from '../../prompts/load-prompt-template.js';
import {
  evaluateWholeChangeReviewVerdict,
  type EvaluatedWholeChangeVerdict,
} from '../../review-fix/read-verdicts.js';
import { createFindingLedger } from '../../review-fix/finding-ledger.js';
import { verifyValidationFreshness } from '../validation-evidence.js';

export interface InitialReviewHandlerOpts {
  profileName?: string;
}

export class InitialReviewHandler implements PhaseHandler {
  readonly phase = PhaseName('initial-review');

  constructor(private readonly opts: InitialReviewHandlerOpts = {}) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('initial_review.started', 'info', 'initial whole-change review started', {
      policy: ctx.executionPolicy,
    });

    // 1. Resume / idempotency check
    try {
      const wholeChangeResult = await ctx.artifacts.read(ctx.runUuid, 'whole-change-review.json');
      if (wholeChangeResult.trim().length > 0) {
        const parsed = JSON.parse(wholeChangeResult) as { verdict?: string };
        if (parsed.verdict === 'APPROVE' || parsed.verdict === 'approve') {
          emit(
            'initial_review.completed',
            'info',
            'initial review already approved (reusing existing review)',
            { policy: ctx.executionPolicy },
          );
          return { outcome: 'passed' };
        }
      }
    } catch {
      // Artifact not present, proceed with review
    }

    // 2. Validate issue truth is present
    let issueMd: string;
    try {
      issueMd = await ctx.artifacts.read(ctx.runUuid, 'issue.md');
    } catch (e) {
      const message =
        e instanceof ArtifactNotFoundError
          ? 'issue.md not found in artifact store'
          : `Failed to read issue.md: ${e instanceof Error ? e.message : String(e)}`;
      return this.fail(ctx, emit, 'missing_artifact', message);
    }

    // 3. Collect complete branch diff against base
    const baseBranch = ctx.expectedBranch ?? ctx.baseBranch ?? 'main';
    let completeDiff = '';
    try {
      if (ctx.git?.diff) {
        completeDiff = await ctx.git.diff(ctx.cwd, ctx.startCommitSha ?? baseBranch);
      }
    } catch {
      completeDiff = '';
    }

    // 4. Verify and collect deterministic validation evidence
    const freshness = await verifyValidationFreshness(ctx);
    if (!freshness.fresh) {
      const message = `Initial review blocked: deterministic validation has not passed or is stale (${freshness.reason ?? 'unknown reason'})`;
      return this.fail(
        ctx,
        emit,
        'validation_failed',
        message,
        'Run deterministic validation before executing initial review.',
      );
    }
    const validationEvidence = `Validation result: passed (fingerprint: ${freshness.expectedFingerprint?.slice(0, 12) ?? 'verified'})`;

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
      resolve('initial-review') ??
      resolve('whole-change-review') ??
      resolve('whole-pr-review') ??
      resolve('implement') ??
      AgentProfileName(this.opts.profileName ?? 'opencode-frontier');

    // 6. Load prompt template
    let template: string | undefined;
    if (ctx.promptsRoot) {
      try {
        template = loadPromptTemplate('review-fix', 'initial-review', {
          promptsRoot: ctx.promptsRoot,
        });
      } catch {
        try {
          template = loadPromptTemplate('review-fix', 'whole-change-review', {
            promptsRoot: ctx.promptsRoot,
          });
        } catch {
          // Handled in runSingleShotAgentPhase
        }
      }
    }

    // 7. Invoke single-shot reviewer agent (read-only)
    const runResult = await runSingleShotAgentPhase(ctx, {
      phase: 'initial-review',
      profile,
      step: 'initial-review',
      ...(template ? { template } : {}),
      vars: {
        issue_number: String(ctx.issueNumber),
        cwd: ctx.cwd,
        complete_diff: completeDiff || '(no diff)',
        validation_evidence: validationEvidence,
      },
      agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
      skipCompletedEmit: true,
    });

    if (runResult.outcome !== 'passed') {
      emit('initial_review.failed', 'error', 'initial reviewer invocation failed');
      return runResult;
    }

    // 8. Extract and validate structured review verdict
    const verdictOutcome = evaluateWholeChangeReviewVerdict(runResult.result, {
      issueBodyPresent: issueMd.trim().length > 0,
    });

    // Initialize finding ledger
    const findingLedger = createFindingLedger(
      verdictOutcome.findings,
      verdictOutcome.acceptanceCriteria,
    );

    // Persist review artifacts (code-review.md, whole-change-review.json, finding-ledger.json)
    const formattedReviewMd = this.formatReviewMarkdown(verdictOutcome);
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
        relativePath: 'whole-change-review.json',
        contents: JSON.stringify(
          {
            verdict: verdictOutcome.verdict,
            acceptance_criteria: verdictOutcome.acceptanceCriteria,
            findings: verdictOutcome.findings,
            summary: verdictOutcome.summary,
            overridden: verdictOutcome.overridden,
            overrideReason: verdictOutcome.overrideReason,
          },
          null,
          2,
        ),
      });
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: this.phase,
        relativePath: 'finding-ledger.json',
        contents: JSON.stringify(findingLedger, null, 2),
      });

      const reviewedHeadSha = await ctx.git?.headCommitSha(ctx.cwd).catch(() => undefined);
      if (reviewedHeadSha?.trim()) {
        await ctx.artifacts.write({
          runId: ctx.runUuid,
          phaseId: this.phase,
          relativePath: 'review-head-sha.txt',
          contents: reviewedHeadSha.trim(),
        });
      }
    } catch (writeErr) {
      return this.fail(
        ctx,
        emit,
        'command_failed',
        `Failed to persist review artifacts: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        'Ensure artifact storage directory is writable.',
      );
    }

    if (verdictOutcome.verdict === 'APPROVE') {
      emit('initial_review.completed', 'info', 'initial review approved', {
        policy: ctx.executionPolicy,
        verdict: 'APPROVE',
        acceptanceCriteriaCount: verdictOutcome.acceptanceCriteria.length,
      });
      return { outcome: 'passed' };
    }

    emit('initial_review.changes_requested', 'warn', 'initial review requested changes', {
      policy: ctx.executionPolicy,
      verdict: 'REQUEST_CHANGES',
      findingsCount: verdictOutcome.findings.length,
      overrideReason: verdictOutcome.overrideReason,
    });
    emit('initial_review.completed', 'info', 'initial review completed with changes requested');
    return { outcome: 'passed' };
  }

  private formatReviewMarkdown(outcome: EvaluatedWholeChangeVerdict): string {
    const lines: string[] = [
      '# Initial Review',
      '',
      `**Verdict:** ${outcome.verdict}`,
      ...(outcome.summary ? [`**Summary:** ${outcome.summary}`, ''] : ['']),
      '## Acceptance Criteria Evaluation',
      '',
    ];

    if (outcome.acceptanceCriteria.length === 0) {
      lines.push('No acceptance criteria listed.');
    } else {
      for (const ac of outcome.acceptanceCriteria) {
        lines.push(`- [${ac.result.toUpperCase()}] ${ac.criterion}`);
        if (ac.evidence) {
          lines.push(`  - Evidence: ${ac.evidence}`);
        }
      }
    }

    lines.push('', '## Findings', '');
    if (outcome.findings.length === 0) {
      lines.push('No defects or blocking findings identified.');
    } else {
      for (const f of outcome.findings) {
        lines.push(`### [${f.severity.toUpperCase()}] Finding`);
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
      suggestedAction: suggestedAction ?? 'Inspect the review logs and retry.',
      artifacts: [],
      detectedAt: ctx.now(),
    };
    emit('initial_review.failed', 'error', message);
    return { outcome: 'failed', failure };
  }
}

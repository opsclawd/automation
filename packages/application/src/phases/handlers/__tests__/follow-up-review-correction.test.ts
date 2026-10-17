import { writeFileSync, unlinkSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { FollowUpReviewHandler } from '../follow-up-review.js';
import { runSingleShotAgentPhase } from '../run-single-shot-agent-phase.js';
import type { PhaseHandlerContext } from '../../handler.js';
import { FakeArtifactStore, FakeAgentPort, FakeGitPort } from '../../../test-doubles/index.js';
import { PhaseName, AgentProfileName, AgentInvocationId } from '@ai-sdlc/domain';
import { createFindingLedger } from '../../../review-fix/finding-ledger.js';
import { recordValidationEvidence } from '../../validation-evidence.js';
import { followUpReviewResultSchema } from '../../../results/schemas/follow-up-review.js';
import { CONTRACT_VIOLATION_CODES } from '../../../ports/contract-violation-codes.js';

const { mockLoadPromptTemplate, mockRenderPrompt } = vi.hoisted(() => ({
  mockLoadPromptTemplate: vi.fn(() => '# Template\n'),
  mockRenderPrompt: vi.fn(async () => '# Follow-Up Review Prompt\n'),
}));

vi.mock('../../../prompts/load-prompt-template.js', () => ({
  loadPromptTemplate: mockLoadPromptTemplate,
}));

vi.mock('../../../prompts/render-prompt.js', () => ({
  renderPrompt: mockRenderPrompt,
}));

describe('Follow-up Review Correction Retry', () => {
  const createMockContext = (
    artifacts: FakeArtifactStore,
    agent: FakeAgentPort,
    git: FakeGitPort,
  ): PhaseHandlerContext => {
    git.currentBranchByCwd.set('/test/repo', 'ai/issue-1308');
    git.headByCwd.set('/test/repo', '0'.repeat(40));
    let invCounter = 0;
    return {
      runUuid: 'run-1308',
      issueNumber: 1308,
      repoFullName: 'owner/repo',
      cwd: '/test/repo',
      executionPolicy: 'standard',
      promptsRoot: '/tmp',
      startCommitSha: '0'.repeat(40),
      expectedBranch: 'ai/issue-1308',
      artifacts,
      agent,
      git,
      events: { publish: vi.fn() },
      now: () => new Date(),
      idFactory: () => `inv-${++invCounter}`,
      resolveProfile: (phase) => phase as never,
    } as unknown as PhaseHandlerContext;
  };

  const setupPrerequisites = async (
    ctx: PhaseHandlerContext,
    artifacts: FakeArtifactStore,
  ): Promise<string> => {
    await recordValidationEvidence(ctx, 'validate');
    await artifacts.write({
      runId: 'run-1308',
      phaseId: PhaseName('read_issue'),
      relativePath: 'issue.md',
      contents: '# Issue 1308',
    });
    const initialLedger = createFindingLedger([
      {
        severity: 'high',
        files: ['src/app.ts'],
        evidence: 'NPE on auth flow',
        rationale: 'Missing null check',
        minimal_correction: 'Add null guard',
      },
    ]);
    const findingId = initialLedger.entries[0]!.id;
    await artifacts.write({
      runId: 'run-1308',
      phaseId: PhaseName('spec-review'),
      relativePath: 'finding-ledger.json',
      contents: JSON.stringify(initialLedger),
    });
    return findingId;
  };

  it('Witness 1: recovers from markdown-only prose with APPROVE and APPROVED via single correction invocation', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);
    const findingId = await setupPrerequisites(ctx, artifacts);

    // Initial attempt: agent writes markdown prose to stdout/worktree, does not create follow-up-review-result.json
    agent.enqueue('follow-up-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1200,
      stdoutPath: '/tmp/stdout-md',
      stderrPath: '/tmp/stderr-md',
      contractViolations: [CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT],
      outcome: 'contract_violation',
    }));

    // Correction retry attempt: writes valid schema JSON to artifact store
    agent.enqueue('follow-up-review', async () => {
      await artifacts.write({
        runId: 'run-1308',
        relativePath: 'follow-up-review-result.json',
        contents: JSON.stringify({
          verdict: 'APPROVE',
          evaluations: [
            {
              finding_id: findingId,
              resolved: true,
              evidence: 'Null guard added at src/app.ts:42',
            },
          ],
          new_findings: [],
          summary: 'Verified fix from retry',
        }),
      });
      return {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 900,
        stdoutPath: '/tmp/stdout-retry',
        stderrPath: '/tmp/stderr-retry',
        resultJsonPath: 'follow-up-review-result.json',
        contractViolations: [],
        outcome: 'success',
      };
    });

    const handler = new FollowUpReviewHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(agent.invocations).toHaveLength(2);

    // Initial invocation
    const inv1 = agent.invocations[0]!;
    expect(inv1.id).toBe('inv-1');

    // Retry invocation asserts
    const inv2 = agent.invocations[1]!;
    expect(inv2.id).toBe('inv-2');
    expect(inv2.fallbackOfInvocationId).toBe('inv-1');
    expect(inv2.fallbackReason).toBe('correction_retry_missing_artifact');
    expect(inv2.metadata?.invocation_type).toBe('correction_retry');
    expect(inv2.metadata?.attempt).toBe(2);
    expect(inv2.metadata?.cause).toBe('missing_artifact');

    // Separate prompt artifact
    const retryPromptRaw = await artifacts.read('run-1308', 'follow-up-review-retry-1-prompt.md');
    expect(retryPromptRaw).toBeDefined();
    // Original prompt.md is preserved and not overwritten
    const initialPromptRaw = await artifacts.read('run-1308', 'prompt.md');
    expect(initialPromptRaw).toBe('# Follow-Up Review Prompt\n');

    // Feedback content in retry prompt
    expect(retryPromptRaw).toContain('## CORRECTION REQUIRED (Attempt 2 of 2)');
    expect(retryPromptRaw).toContain('./follow-up-review-result.json');
    expect(retryPromptRaw).toContain('APPROVE');
    expect(retryPromptRaw).toContain('REQUEST_CHANGES');
    expect(retryPromptRaw).toContain('finding_id');
    expect(retryPromptRaw).toContain('resolved');
    expect(retryPromptRaw).toContain('evidence');

    // Downstream state updated from retry JSON
    const ledgerRaw = await artifacts.read('run-1308', 'finding-ledger.json');
    const updatedLedger = JSON.parse(ledgerRaw);
    expect(updatedLedger.entries[0].status).toBe('resolved');

    const derivedReviewRaw = await artifacts.read('run-1308', 'follow-up-review.json');
    const derivedReview = JSON.parse(derivedReviewRaw);
    expect(derivedReview.verdict).toBe('APPROVE');

    // Completed event emitted
    const publishedEvents = (ctx.events.publish as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const completedEvents = publishedEvents.filter(
      (call) => (call[1] as { type?: string })?.type === 'follow_up_review.completed',
    );
    expect(completedEvents).toHaveLength(1);
  });

  it('Witness 2: recovers from invalid enum "APPROVED" via schema rejection feedback and retry', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);
    const findingId = await setupPrerequisites(ctx, artifacts);

    // Initial attempt: writes JSON with invalid enum literal "APPROVED"
    agent.enqueue('follow-up-review', async () => {
      await artifacts.write({
        runId: 'run-1308',
        relativePath: 'follow-up-review-result.json',
        contents: JSON.stringify({
          verdict: 'APPROVED',
          evaluations: [
            {
              finding_id: findingId,
              resolved: true,
              evidence: 'Null guard verified',
            },
          ],
          new_findings: [],
          summary: 'Approved verdict using invalid literal',
        }),
      });
      return {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/tmp/stdout-invalid-enum',
        stderrPath: '/tmp/stderr',
        resultJsonPath: 'follow-up-review-result.json',
        contractViolations: [],
        outcome: 'success',
      };
    });

    // Correction retry attempt: self-corrects to "APPROVE"
    agent.enqueue('follow-up-review', async () => {
      await artifacts.write({
        runId: 'run-1308',
        relativePath: 'follow-up-review-result.json',
        contents: JSON.stringify({
          verdict: 'APPROVE',
          evaluations: [
            {
              finding_id: findingId,
              resolved: true,
              evidence: 'Null guard verified',
            },
          ],
          new_findings: [],
          summary: 'Corrected verdict literal to APPROVE',
        }),
      });
      return {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 800,
        stdoutPath: '/tmp/stdout-retry',
        stderrPath: '/tmp/stderr-retry',
        resultJsonPath: 'follow-up-review-result.json',
        contractViolations: [],
        outcome: 'success',
      };
    });

    const handler = new FollowUpReviewHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(agent.invocations).toHaveLength(2);

    // Verify feedback specifically quotes "APPROVED" as invalid
    const retryPromptRaw = await artifacts.read('run-1308', 'follow-up-review-retry-1-prompt.md');
    expect(retryPromptRaw).toContain('"APPROVED"');
    expect(retryPromptRaw).toContain('NOT a valid verdict literal');
    expect(retryPromptRaw).toContain('APPROVE');
    expect(retryPromptRaw).toContain('REQUEST_CHANGES');

    // Confirm production schema still strictly rejects APPROVED
    const schemaValidation = followUpReviewResultSchema.safeParse({
      verdict: 'APPROVED',
      evaluations: [{ finding_id: 'f-1', resolved: true, evidence: 'ev' }],
    });
    expect(schemaValidation.success).toBe(false);
  });

  it('Witness 3: blocking freshness witness proves invalidation removes prior result and stale output cannot mask empty retry', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);
    const findingId = await setupPrerequisites(ctx, artifacts);

    // Pre-seed a valid schema artifact in durable store and worktree before attempt 1
    await artifacts.write({
      runId: 'run-1308',
      relativePath: 'follow-up-review-result.json',
      contents: JSON.stringify({
        verdict: 'APPROVE',
        evaluations: [{ finding_id: findingId, resolved: true, evidence: 'valid first attempt' }],
      }),
    });

    // Attempt 1 completes with contract_violation: missing_required_artifact
    agent.enqueue('follow-up-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout-1',
      stderrPath: '/tmp/stderr-1',
      contractViolations: [CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT],
      outcome: 'contract_violation',
    }));

    // Attempt 2 writes NOTHING and also returns contract_violation: missing_required_artifact
    agent.enqueue('follow-up-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout-2',
      stderrPath: '/tmp/stderr-2',
      contractViolations: [CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT],
      outcome: 'contract_violation',
    }));

    const handler = new FollowUpReviewHandler();
    const result = await handler.run(ctx);

    // Exactly 2 invocations occurred
    expect(agent.invocations).toHaveLength(2);

    // Phase fails because invalidation wiped the prior result and retry did not produce one
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('agent_contract_violation');
      expect(result.failure.message).toContain('missing_required_artifact');
    }

    // Result is truly gone from store
    await expect(artifacts.read('run-1308', 'follow-up-review-result.json')).rejects.toThrow();

    // No derived follow-up review was written
    await expect(artifacts.read('run-1308', 'follow-up-review.json')).rejects.toThrow();

    // No completed event emitted
    const publishedEvents = (ctx.events.publish as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const completedEvents = publishedEvents.filter(
      (call) => (call[1] as { type?: string })?.type === 'follow_up_review.completed',
    );
    expect(completedEvents).toHaveLength(0);
  });

  it('Witness 4: terminal phase failure when retry output is malformed or schema-invalid (no third attempt)', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);
    await setupPrerequisites(ctx, artifacts);

    // Attempt 1: missing required artifact
    agent.enqueue('follow-up-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout-1',
      stderrPath: '/tmp/stderr-1',
      contractViolations: [CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT],
      outcome: 'contract_violation',
    }));

    // Attempt 2: writes malformed JSON
    agent.enqueue('follow-up-review', async () => {
      await artifacts.write({
        runId: 'run-1308',
        relativePath: 'follow-up-review-result.json',
        contents: '{ unparseable garbage json :::',
      });
      return {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/tmp/stdout-2',
        stderrPath: '/tmp/stderr-2',
        resultJsonPath: 'follow-up-review-result.json',
        contractViolations: [],
        outcome: 'success',
      };
    });

    const handler = new FollowUpReviewHandler();
    const result = await handler.run(ctx);

    // Exactly 2 invocations occurred (no third attempt)
    expect(agent.invocations).toHaveLength(2);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('invalid_result');
      expect(result.failure.message).toContain('JSON.parse failed');
      expect(result.failure.canRetry).toBe(false);
    }

    // No derived review written
    await expect(artifacts.read('run-1308', 'follow-up-review.json')).rejects.toThrow();
  });

  describe('Witness 5: noneligible failures and scope constraints', () => {
    it('does not retry runtime timeout', async () => {
      const artifacts = new FakeArtifactStore();
      const agent = new FakeAgentPort();
      const git = new FakeGitPort();
      const ctx = createMockContext(artifacts, agent, git);
      await setupPrerequisites(ctx, artifacts);

      agent.enqueue('follow-up-review', () => ({
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 124,
        durationMs: 60000,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        contractViolations: [],
        outcome: 'timeout',
      }));

      const handler = new FollowUpReviewHandler();
      const result = await handler.run(ctx);

      expect(agent.invocations).toHaveLength(1);
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.failure.kind).toBe('timeout');
      }
    });

    it('does not retry unrelated contract violations (e.g. branch_changed)', async () => {
      const artifacts = new FakeArtifactStore();
      const agent = new FakeAgentPort();
      const git = new FakeGitPort();
      const ctx = createMockContext(artifacts, agent, git);
      await setupPrerequisites(ctx, artifacts);

      agent.enqueue('follow-up-review', () => ({
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        contractViolations: [CONTRACT_VIOLATION_CODES.BRANCH_CHANGED],
        outcome: 'contract_violation',
      }));

      const handler = new FollowUpReviewHandler();
      const result = await handler.run(ctx);

      expect(agent.invocations).toHaveLength(1);
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.failure.kind).toBe('agent_contract_violation');
        expect(result.failure.message).toContain('branch_changed');
      }
    });

    it('fails immediately when artifact invalidation fails and does not invoke retry', async () => {
      const artifacts = new FakeArtifactStore();
      const agent = new FakeAgentPort();
      const git = new FakeGitPort();
      const ctx = createMockContext(artifacts, agent, git);
      await setupPrerequisites(ctx, artifacts);

      // Trigger eligible failure on attempt 1
      agent.enqueue('follow-up-review', () => ({
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        contractViolations: [CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT],
        outcome: 'contract_violation',
      }));

      // Simulate invalidation failure
      artifacts.shouldThrowOnInvalidate = true;

      const handler = new FollowUpReviewHandler();
      const result = await handler.run(ctx);

      // Invalidation failure blocked retry; only 1 invocation occurred
      expect(agent.invocations).toHaveLength(1);
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.failure.message).toContain('Artifact invalidation failed');
      }
    });

    it('does not apply correction retry to other phases (e.g. fix-review)', async () => {
      const artifacts = new FakeArtifactStore();
      const agent = new FakeAgentPort();
      const git = new FakeGitPort();
      const ctx = createMockContext(artifacts, agent, git);

      agent.enqueue('fix-review', () => ({
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        contractViolations: [CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT],
        outcome: 'contract_violation',
      }));

      const result = await runSingleShotAgentPhase(ctx, {
        phase: PhaseName('fix-review'),
        profile: AgentProfileName('fix-review'),
        step: 'fix-review',
        vars: { cwd: ctx.cwd },
        resultJsonPath: 'fix-review-result.json',
        agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
      });

      // Exactly 1 invocation; no correction retry occurred
      expect(agent.invocations).toHaveLength(1);
      expect(result.outcome).toBe('failed');
    });
  });

  describe('Witness 6: structured-result repair bypass and authority', () => {
    it('does not invoke repair port even when stdout contains plausible markdown, recovering exclusively via correction retry', async () => {
      const artifacts = new FakeArtifactStore();
      const agent = new FakeAgentPort();
      const git = new FakeGitPort();
      const ctx = createMockContext(artifacts, agent, git);
      const findingId = await setupPrerequisites(ctx, artifacts);

      const stdoutFile = `/tmp/stdout-md-repair-bypass-${Date.now()}.txt`;
      writeFileSync(
        stdoutFile,
        '# Review Summary\n\nVerdict: APPROVE\n\nAll findings have been verified resolved with file:line citations.\n',
      );

      // Provide a repair port that would succeed if invoked
      const repairSpy = vi.fn(async () => {
        await artifacts.write({
          runId: 'run-1308',
          relativePath: 'follow-up-review-result.json',
          contents: JSON.stringify({
            verdict: 'APPROVE',
            evaluations: [
              {
                finding_id: findingId,
                resolved: true,
                evidence: 'Extracted from prose by repair port (should never be called)',
              },
            ],
            new_findings: [],
            summary: 'Repaired from prose',
          }),
        });
        return {
          outcome: 'repaired' as const,
          repairInvocationId: AgentInvocationId('repair-inv-1'),
        };
      });
      ctx.repair = {
        repairStructuredResult: repairSpy,
      };

      try {
        // Initial attempt: exits 0, no result JSON created, but stdout contains plausible markdown
        agent.enqueue('follow-up-review', () => ({
          runtime: 'opencode',
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          exitCode: 0,
          durationMs: 1200,
          stdoutPath: stdoutFile,
          stderrPath: '/tmp/stderr-md',
          contractViolations: [CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT],
          outcome: 'contract_violation',
        }));

        // Correction retry attempt: writes valid schema JSON directly to artifact store
        agent.enqueue('follow-up-review', async () => {
          await artifacts.write({
            runId: 'run-1308',
            relativePath: 'follow-up-review-result.json',
            contents: JSON.stringify({
              verdict: 'APPROVE',
              evaluations: [
                {
                  finding_id: findingId,
                  resolved: true,
                  evidence: 'Null guard added at src/app.ts:42 (from explicit correction retry)',
                },
              ],
              new_findings: [],
              summary: 'Verified fix from explicit correction retry',
            }),
          });
          return {
            runtime: 'opencode',
            provider: 'anthropic',
            model: 'claude-sonnet-4-20250514',
            exitCode: 0,
            durationMs: 900,
            stdoutPath: '/tmp/stdout-retry',
            stderrPath: '/tmp/stderr-retry',
            resultJsonPath: 'follow-up-review-result.json',
            contractViolations: [],
            outcome: 'success',
          };
        });

        const handler = new FollowUpReviewHandler();
        const result = await handler.run(ctx);

        expect(result.outcome).toBe('passed');

        // Crucial assertion: repairStructuredResult was never called
        expect(repairSpy).not.toHaveBeenCalled();

        // Exactly 2 agent invocations occurred (initial + correction retry)
        expect(agent.invocations).toHaveLength(2);

        // Derived review and ledger come from correction retry, not from repair
        const derivedReviewRaw = await artifacts.read('run-1308', 'follow-up-review.json');
        const derivedReview = JSON.parse(derivedReviewRaw);
        expect(derivedReview.summary).toBe('Verified fix from explicit correction retry');

        const ledgerRaw = await artifacts.read('run-1308', 'finding-ledger.json');
        const updatedLedger = JSON.parse(ledgerRaw);
        expect(updatedLedger.entries[0].status).toBe('resolved');
      } finally {
        try {
          unlinkSync(stdoutFile);
        } catch {
          // ignore
        }
      }
    });

    it('preserves existing repair behavior for non-follow-up-review phases', async () => {
      const artifacts = new FakeArtifactStore();
      const agent = new FakeAgentPort();
      const git = new FakeGitPort();
      const ctx = createMockContext(artifacts, agent, git);

      const stdoutFile = `/tmp/stdout-other-phase-${Date.now()}.txt`;
      writeFileSync(stdoutFile, '{"status": "ok"}\n');

      const repairSpy = vi.fn(async () => {
        await artifacts.write({
          runId: 'run-1308',
          relativePath: 'result.json',
          contents: JSON.stringify({
            status: 'repaired_for_other_phase',
          }),
        });
        return {
          outcome: 'repaired' as const,
          repairInvocationId: AgentInvocationId('repair-inv-other'),
        };
      });
      ctx.repair = {
        repairStructuredResult: repairSpy,
      };

      try {
        agent.enqueue('spec-review', () => ({
          runtime: 'opencode',
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          exitCode: 0,
          durationMs: 1000,
          stdoutPath: stdoutFile,
          stderrPath: '/tmp/stderr',
          contractViolations: [],
          outcome: 'success',
        }));

        // Run an arbitrary phase without correctionRetry
        await runSingleShotAgentPhase(ctx, {
          phase: PhaseName('spec-review'),
          profile: AgentProfileName('spec-review'),
          step: 'spec-review',
          vars: { cwd: ctx.cwd },
          resultJsonPath: 'result.json',
          agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
        });

        // For non-correctionRetry phases, repair is NOT disabled
        expect(repairSpy).toHaveBeenCalledTimes(1);
      } finally {
        try {
          unlinkSync(stdoutFile);
        } catch {
          // ignore
        }
      }
    });
  });
});

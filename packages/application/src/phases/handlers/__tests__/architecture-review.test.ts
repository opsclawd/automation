import { describe, it, expect, vi } from 'vitest';
import { PhaseName, AgentProfileName, type AgentInvocationId, type RunId } from '@ai-sdlc/domain';
import { ArchitectureReviewHandler } from '../architecture-review.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeAgentPort } from '../../../test-doubles/fake-agent-port.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import { FakeGitHubPort } from '../../../test-doubles/fake-github-port.js';
import type { PhaseHandlerContext } from '../../handler.js';

import { fileURLToPath } from 'node:url';

const PROMPTS_ROOT = fileURLToPath(new URL('../../../../../../prompts', import.meta.url));

describe('ArchitectureReviewHandler', () => {
  const createTestContext = (overrides: Partial<PhaseHandlerContext> = {}): PhaseHandlerContext => {
    const runUuid = 'run-123';
    const cwd = '/test/repo';
    const issueNumber = 1129;
    const startCommitSha = 'start123';
    const expectedBranch = 'feature-1129';
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    git.currentBranchByCwd.set(cwd, expectedBranch);
    git.headByCwd.set(cwd, startCommitSha);
    const github = new FakeGitHubPort();

    return {
      runUuid,
      issueNumber,
      repoFullName: 'test-org/test-repo',
      cwd,
      executionPolicy: 'strict',
      startCommitSha,
      expectedBranch,
      promptsRoot: PROMPTS_ROOT,
      artifacts,
      agent,
      git,
      github,
      events: { publish: vi.fn() },
      now: () => new Date('2026-08-29T20:00:00.000Z'),
      resolveProfile: (phase: string) => AgentProfileName(`profile-for-${phase}`),
      idFactory: () => 'inv-1',
      ...overrides,
    };
  };

  function eventsOf(ctx: PhaseHandlerContext, eventType: string) {
    const calls = (ctx.events.publish as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    return calls.filter((c) => (c[1] as { type?: string })?.type === eventType);
  }

  it('skips agent invocation and returns passed under standard policy', async () => {
    const handler = new ArchitectureReviewHandler();
    const ctx = createTestContext({ executionPolicy: 'standard' });

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('passed');
    expect(ctx.events.publish).toHaveBeenCalledWith(
      ctx.runUuid,
      expect.objectContaining({
        type: 'architecture_review.skipped',
      }),
    );
  });

  it('re-uses existing approved architecture-review.json on resume', async () => {
    const handler = new ArchitectureReviewHandler();
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'architecture-review.json',
      contents: JSON.stringify({
        verdict: 'APPROVE',
        requirements_checks: [{ requirement: 'Req 1', result: 'PASS' }],
        findings: [],
      }),
    });

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('passed');
    expect(ctx.events.publish).toHaveBeenCalledWith(
      ctx.runUuid,
      expect.objectContaining({
        type: 'architecture_review.completed',
        message: expect.stringContaining('reusing existing review'),
      }),
    );
  });

  it('fails if issue.md, design.md, or plan.md is missing', async () => {
    const handler = new ArchitectureReviewHandler();
    const ctx = createTestContext();

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('missing_artifact');
    }
  });

  it('passes on initial review when reviewer approves with no blocking findings and all ledger items checked', async () => {
    const handler = new ArchitectureReviewHandler();
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1129\n## Acceptance criteria\n- [ ] Requirements reconciliation\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1129\nAnchored design details.',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents:
        '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: do setup\n- Invariants: none\n- Verification: `pnpm test`\n',
    });

    const agent = ctx.agent as FakeAgentPort;
    const reviewerProfile = 'profile-for-architecture-review';
    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'APPROVE',
          requirements_checks: [
            { requirement_id: 'AC-1', requirement: 'Requirements reconciliation', result: 'PASS' },
          ],
          findings: [],
          summary: 'All requirements and invariants satisfied.',
        }),
      });
      return {
        id: 'inv-1' as AgentInvocationId,
        runId: ctx.runUuid as RunId,
        phaseId: PhaseName('architecture-review'),
        profile: AgentProfileName(reviewerProfile),
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        startedAt: new Date(),
        endedAt: new Date(),
        startCommitSha: 'sha123',
        exitCode: 0,
        durationMs: 100,
        timeoutMs: 1000,
        outcome: 'success',
        contractViolations: [],
      };
    });

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('passed');
    expect(eventsOf(ctx, 'architecture_review.completed')).toHaveLength(1);

    // Verifies architecture-requirements.json was created
    const ledgerArtifact = await ctx.artifacts.read(ctx.runUuid, 'architecture-requirements.json');
    expect(JSON.parse(ledgerArtifact).items).toHaveLength(1);

    const persistedReview = await ctx.artifacts.read(ctx.runUuid, 'architecture-review.json');
    expect(JSON.parse(persistedReview).verdict).toBe('APPROVE');
  });

  it('invokes targeted planner correction and passes when re-verification succeeds', async () => {
    const handler = new ArchitectureReviewHandler();
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1129\n## Acceptance criteria\n- [ ] Contract conservation\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1129\nInitial design missing contract.',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents:
        '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: do setup\n- Invariants: none\n- Verification: `pnpm test`\n',
    });

    const agent = ctx.agent as FakeAgentPort;
    const reviewerProfile = 'profile-for-architecture-review';
    const plannerProfile = 'profile-for-architecture-fix';

    // 1. Initial Review -> REQUEST_CHANGES with finding
    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Contract conservation',
              result: 'FAIL',
              evidence: 'Missing field x',
            },
          ],
          findings: [
            {
              category: 'contract_conservation',
              severity: 'high',
              target: 'design.md',
              evidence: 'Field x is missing from schema',
              rationale: 'Required by downstream consumer',
              minimal_correction: 'Add field x to schema',
              blocking: true,
            },
          ],
          summary: 'Contract conservation defect.',
        }),
      });
      return {
        id: 'inv-1' as AgentInvocationId,
        runId: ctx.runUuid as RunId,
        phaseId: PhaseName('architecture-review'),
        profile: AgentProfileName(reviewerProfile),
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        startedAt: new Date(),
        endedAt: new Date(),
        startCommitSha: 'sha123',
        exitCode: 0,
        durationMs: 100,
        timeoutMs: 1000,
        outcome: 'success',
        contractViolations: [],
      };
    });

    // 2. Targeted Planner Correction -> Updated design and plan
    agent.enqueue(plannerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          design_md: '# Design 1129\nAdded field x to schema.',
          plan_md:
            '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: do setup\n- Invariants: field x conserved\n- Verification: `pnpm test`\n',
        }),
      });
      return {
        id: 'inv-2' as AgentInvocationId,
        runId: ctx.runUuid as RunId,
        phaseId: PhaseName('architecture-review'),
        profile: AgentProfileName(plannerProfile),
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        startedAt: new Date(),
        endedAt: new Date(),
        startCommitSha: 'sha123',
        exitCode: 0,
        durationMs: 100,
        timeoutMs: 1000,
        outcome: 'success',
        contractViolations: [],
      };
    });

    // 3. Verification Review -> APPROVE with no findings
    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'APPROVE',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Contract conservation',
              result: 'PASS',
              evidence: 'Field x is now present in schema',
            },
          ],
          findings: [],
          summary: 'All findings resolved and contract conserved.',
        }),
      });
      return {
        id: 'inv-3' as AgentInvocationId,
        runId: ctx.runUuid as RunId,
        phaseId: PhaseName('architecture-review'),
        profile: AgentProfileName(reviewerProfile),
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        startedAt: new Date(),
        endedAt: new Date(),
        startCommitSha: 'sha123',
        exitCode: 0,
        durationMs: 100,
        timeoutMs: 1000,
        outcome: 'success',
        contractViolations: [],
      };
    });

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('passed');

    // Authoritative artifacts updated for implement phase
    const updatedDesign = await ctx.artifacts.read(ctx.runUuid, 'design.md');
    expect(updatedDesign).toContain('Added field x to schema.');

    expect(eventsOf(ctx, 'architecture_review.findings_found')).toHaveLength(1);
    expect(eventsOf(ctx, 'architecture_review.verification_started')).toHaveLength(1);
    expect(eventsOf(ctx, 'architecture_review.completed')).toHaveLength(1);
  });

  it('rejects approval when a ledger item is omitted from reviewer output', async () => {
    const handler = new ArchitectureReviewHandler({ maxCorrections: 0 });
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: `
# Issue 1129
## Acceptance criteria
- [ ] Representational completeness
- [ ] Downstream timeline consumer support
`,
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design\nSchema details.',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents:
        '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: setup\n- Invariants: none\n- Verification: `pnpm test`\n',
    });

    const agent = ctx.agent as FakeAgentPort;
    const reviewerProfile = 'profile-for-architecture-review';

    // Reviewer returns APPROVE but only checked AC-1, completely omitting AC-2
    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'APPROVE',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Representational completeness',
              result: 'PASS',
            },
          ],
          findings: [],
        }),
      });
      return {
        id: 'inv-1' as AgentInvocationId,
        runId: ctx.runUuid as RunId,
        phaseId: PhaseName('architecture-review'),
        profile: AgentProfileName(reviewerProfile),
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        startedAt: new Date(),
        endedAt: new Date(),
        startCommitSha: 'sha123',
        exitCode: 0,
        durationMs: 100,
        timeoutMs: 1000,
        outcome: 'success',
        contractViolations: [],
      };
    });

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('needs_human_review');
    expect(eventsOf(ctx, 'architecture_review.exhausted')).toHaveLength(1);
  });

  it('rejects approval when a contract is internally consistent but a required consumer scenario cannot be represented', async () => {
    const handler = new ArchitectureReviewHandler({ maxCorrections: 0 });
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1129\n## Goal\nSupport looping soundbeds losslessly\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design\nFixed length duration field only.',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents:
        '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: setup\n- Invariants: none\n- Verification: `pnpm test`\n',
    });

    const agent = ctx.agent as FakeAgentPort;
    const reviewerProfile = 'profile-for-architecture-review';

    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          requirements_checks: [
            {
              requirement_id: 'REQ-GOAL-1',
              requirement: 'Support looping soundbeds losslessly',
              result: 'FAIL',
              evidence:
                'Fixed length duration field cannot represent repeated segment loops with tail trim',
            },
          ],
          findings: [
            {
              category: 'representational_completeness',
              severity: 'critical',
              target: 'design.md',
              evidence: 'Missing loop count and tail trim parameters in timeline soundbed schema',
              rationale: 'Consumer timeline assembly cannot losslessly reconstruct looped audio',
              minimal_correction: 'Add loop parameters to soundbed track schema',
              blocking: true,
            },
          ],
        }),
      });
      return {
        id: 'inv-1' as AgentInvocationId,
        runId: ctx.runUuid as RunId,
        phaseId: PhaseName('architecture-review'),
        profile: AgentProfileName(reviewerProfile),
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        startedAt: new Date(),
        endedAt: new Date(),
        startCommitSha: 'sha123',
        exitCode: 0,
        durationMs: 100,
        timeoutMs: 1000,
        outcome: 'success',
        contractViolations: [],
      };
    });

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('needs_human_review');
  });

  it('rejects approval when reviewer treats profile/configuration identity as proof of measured/executed provenance', async () => {
    const handler = new ArchitectureReviewHandler({ maxCorrections: 0 });
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents:
        '# Issue 1129\n## Acceptance criteria\n- [ ] Provenance layering must record probe metadata\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design\nRecords profileId only.',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents:
        '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: setup\n- Invariants: none\n- Verification: `pnpm test`\n',
    });

    const agent = ctx.agent as FakeAgentPort;
    const reviewerProfile = 'profile-for-architecture-review';

    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Provenance layering must record probe metadata',
              result: 'FAIL',
              evidence: 'Design assumes profileId proves measured audio sample rate and duration',
            },
          ],
          findings: [
            {
              category: 'provenance_layering',
              severity: 'high',
              target: 'design.md',
              evidence:
                'Layer conflation: profileId is requested/configured layer, not measured/verified stream probe data',
              rationale:
                'Executed audio streams may drift from profile default and require probe measurements',
              minimal_correction: 'Add probeStreamMetadata to manifest audit record',
              blocking: true,
            },
          ],
        }),
      });
      return {
        id: 'inv-1' as AgentInvocationId,
        runId: ctx.runUuid as RunId,
        phaseId: PhaseName('architecture-review'),
        profile: AgentProfileName(reviewerProfile),
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        startedAt: new Date(),
        endedAt: new Date(),
        startCommitSha: 'sha123',
        exitCode: 0,
        durationMs: 100,
        timeoutMs: 1000,
        outcome: 'success',
        contractViolations: [],
      };
    });

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('needs_human_review');
  });

  it('rejects approval when a conditionally required field remains optional without an enforcing invariant', async () => {
    const handler = new ArchitectureReviewHandler({ maxCorrections: 0 });
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1129\n## Goal\nEnsure subtitle rendering invariants\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design\nsubtitleStyleProfile is optional.',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents:
        '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: setup\n- Invariants: none\n- Verification: `pnpm test`\n',
    });

    const agent = ctx.agent as FakeAgentPort;
    const reviewerProfile = 'profile-for-architecture-review';

    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          requirements_checks: [
            {
              requirement_id: 'REQ-GOAL-1',
              requirement: 'Ensure subtitle rendering invariants',
              result: 'FAIL',
              evidence: 'subtitleStyleProfile is optional even when subtitleCues is non-empty',
            },
          ],
          findings: [
            {
              category: 'conditional_invariants',
              severity: 'high',
              target: 'design.md',
              evidence:
                'Optional field without conditional invariant: subtitleStyleProfile must be defined if subtitleCues.length > 0',
              rationale:
                'Renderer will throw unhandled exception if cues exist but style profile is undefined',
              minimal_correction: 'Add conditional invariant refinement to timeline schema',
              blocking: true,
            },
          ],
        }),
      });
      return {
        id: 'inv-1' as AgentInvocationId,
        runId: ctx.runUuid as RunId,
        phaseId: PhaseName('architecture-review'),
        profile: AgentProfileName(reviewerProfile),
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        startedAt: new Date(),
        endedAt: new Date(),
        startCommitSha: 'sha123',
        exitCode: 0,
        durationMs: 100,
        timeoutMs: 1000,
        outcome: 'success',
        contractViolations: [],
      };
    });

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('needs_human_review');
  });

  it('rejects approval when one of the bounded consumer witness scenarios fails while other requirement checks pass', async () => {
    const handler = new ArchitectureReviewHandler({ maxCorrections: 0 });
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1129\n## Acceptance criteria\n- [ ] General contract check\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design\nTimeline schema.',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents:
        '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: setup\n- Invariants: none\n- Verification: `pnpm test`\n',
    });

    const agent = ctx.agent as FakeAgentPort;
    const reviewerProfile = 'profile-for-architecture-review';

    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'APPROVE',
          requirements_checks: [
            { requirement_id: 'AC-1', requirement: 'General contract check', result: 'PASS' },
          ],
          witness_scenarios: [
            {
              scenario: 'Direct consumer issue #128: 12s soundbed looped across 30s video timeline',
              result: 'FAIL',
              evidence: 'Current schema truncates after first iteration; cannot represent looping',
              counterexample: 'Source duration < target duration with fractional loop tail',
            },
          ],
          findings: [],
        }),
      });
      return {
        id: 'inv-1' as AgentInvocationId,
        runId: ctx.runUuid as RunId,
        phaseId: PhaseName('architecture-review'),
        profile: AgentProfileName(reviewerProfile),
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        startedAt: new Date(),
        endedAt: new Date(),
        startCommitSha: 'sha123',
        exitCode: 0,
        durationMs: 100,
        timeoutMs: 1000,
        outcome: 'success',
        contractViolations: [],
      };
    });

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('needs_human_review');
    expect(eventsOf(ctx, 'architecture_review.exhausted')).toHaveLength(1);
  });

  it('escalates to needs_human_review when re-verification fails (maxCorrections: 1)', async () => {
    const handler = new ArchitectureReviewHandler({ maxCorrections: 1 });
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1129\n## Acceptance criteria\n- [ ] Invariant completeness\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1129\nInitial design.',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents:
        '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: do setup\n- Invariants: none\n- Verification: `pnpm test`\n',
    });

    const agent = ctx.agent as FakeAgentPort;
    const reviewerProfile = 'profile-for-architecture-review';
    const plannerProfile = 'profile-for-architecture-fix';

    // 1. Initial Review -> REQUEST_CHANGES
    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Invariant completeness',
              result: 'FAIL',
              evidence: 'Gap',
            },
          ],
          findings: [
            {
              category: 'invariant_completeness',
              severity: 'high',
              target: 'plan.md',
              evidence: 'Invariant missing',
              rationale: 'State corruption risk',
              minimal_correction: 'Add invariant',
              blocking: true,
            },
          ],
        }),
      });
      return {
        id: 'inv-1' as AgentInvocationId,
        runId: ctx.runUuid as RunId,
        phaseId: PhaseName('architecture-review'),
        profile: AgentProfileName(reviewerProfile),
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        startedAt: new Date(),
        endedAt: new Date(),
        startCommitSha: 'sha123',
        exitCode: 0,
        durationMs: 100,
        timeoutMs: 1000,
        outcome: 'success',
        contractViolations: [],
      };
    });

    // 2. Targeted Planner Correction
    agent.enqueue(plannerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          design_md: '# Design 1129\nAttempted fix.',
          plan_md:
            '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: do setup\n- Invariants: partial invariant\n- Verification: `pnpm test`\n',
        }),
      });
      return {
        id: 'inv-2' as AgentInvocationId,
        runId: ctx.runUuid as RunId,
        phaseId: PhaseName('architecture-review'),
        profile: AgentProfileName(plannerProfile),
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        startedAt: new Date(),
        endedAt: new Date(),
        startCommitSha: 'sha123',
        exitCode: 0,
        durationMs: 100,
        timeoutMs: 1000,
        outcome: 'success',
        contractViolations: [],
      };
    });

    // 3. Re-verification -> Still has blocking finding
    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Invariant completeness',
              result: 'FAIL',
              evidence: 'Still incomplete',
            },
          ],
          findings: [
            {
              category: 'invariant_completeness',
              severity: 'high',
              target: 'plan.md',
              evidence: 'Partial invariant insufficient',
              rationale: 'State corruption risk remains',
              minimal_correction: 'Enforce full state machine transition checks',
              blocking: true,
            },
          ],
        }),
      });
      return {
        id: 'inv-3' as AgentInvocationId,
        runId: ctx.runUuid as RunId,
        phaseId: PhaseName('architecture-review'),
        profile: AgentProfileName(reviewerProfile),
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        startedAt: new Date(),
        endedAt: new Date(),
        startCommitSha: 'sha123',
        exitCode: 0,
        durationMs: 100,
        timeoutMs: 1000,
        outcome: 'success',
        contractViolations: [],
      };
    });

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('needs_human_review');
    expect(eventsOf(ctx, 'architecture_review.exhausted')).toHaveLength(1);
  });

  it('supports multiple corrections (maxCorrections: 2) and succeeds when second verification passes', async () => {
    const handler = new ArchitectureReviewHandler({ maxCorrections: 2 });
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1129\n## Acceptance criteria\n- [ ] Full reconciliation\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1129\nInitial design.',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents:
        '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: do setup\n- Invariants: none\n- Verification: `pnpm test`\n',
    });

    const agent = ctx.agent as FakeAgentPort;
    const reviewerProfile = 'profile-for-architecture-review';
    const plannerProfile = 'profile-for-architecture-fix';

    // 1. Initial Review -> Fail
    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Full reconciliation',
              result: 'FAIL',
              evidence: 'Gap 1',
            },
          ],
          findings: [
            {
              category: 'requirements_reconciliation',
              severity: 'high',
              target: 'design.md',
              evidence: 'Gap 1',
              rationale: 'Missing requirement',
              minimal_correction: 'Fix gap 1',
              blocking: true,
            },
          ],
        }),
      });
      return {
        id: 'inv-1' as AgentInvocationId,
        runId: ctx.runUuid as RunId,
        phaseId: PhaseName('architecture-review'),
        profile: AgentProfileName(reviewerProfile),
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        startedAt: new Date(),
        endedAt: new Date(),
        startCommitSha: 'sha123',
        exitCode: 0,
        durationMs: 100,
        timeoutMs: 1000,
        outcome: 'success',
        contractViolations: [],
      };
    });

    // 2. First Planner fix
    agent.enqueue(plannerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          design_md: '# Design 1129\nResolved gap 1.',
          plan_md:
            '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: fix gap 1\n- Invariants: none\n- Verification: `pnpm test`\n',
        }),
      });
      return {
        id: 'inv-2' as AgentInvocationId,
        runId: ctx.runUuid as RunId,
        phaseId: PhaseName('architecture-review'),
        profile: AgentProfileName(plannerProfile),
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        startedAt: new Date(),
        endedAt: new Date(),
        startCommitSha: 'sha123',
        exitCode: 0,
        durationMs: 100,
        timeoutMs: 1000,
        outcome: 'success',
        contractViolations: [],
      };
    });

    // 3. First re-verification -> Still has Gap 2
    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Full reconciliation',
              result: 'FAIL',
              evidence: 'Gap 2',
            },
          ],
          findings: [
            {
              category: 'contract_conservation',
              severity: 'high',
              target: 'design.md',
              evidence: 'Gap 2',
              rationale: 'Missing persistence',
              minimal_correction: 'Fix gap 2',
              blocking: true,
            },
          ],
        }),
      });
      return {
        id: 'inv-3' as AgentInvocationId,
        runId: ctx.runUuid as RunId,
        phaseId: PhaseName('architecture-review'),
        profile: AgentProfileName(reviewerProfile),
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        startedAt: new Date(),
        endedAt: new Date(),
        startCommitSha: 'sha123',
        exitCode: 0,
        durationMs: 100,
        timeoutMs: 1000,
        outcome: 'success',
        contractViolations: [],
      };
    });

    // 4. Second Planner fix
    agent.enqueue(plannerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          design_md: '# Design 1129\nResolved gap 1 and gap 2.',
          plan_md:
            '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: fix gap 1 and gap 2\n- Invariants: all conserved\n- Verification: `pnpm test`\n',
        }),
      });
      return {
        id: 'inv-4' as AgentInvocationId,
        runId: ctx.runUuid as RunId,
        phaseId: PhaseName('architecture-review'),
        profile: AgentProfileName(plannerProfile),
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        startedAt: new Date(),
        endedAt: new Date(),
        startCommitSha: 'sha123',
        exitCode: 0,
        durationMs: 100,
        timeoutMs: 1000,
        outcome: 'success',
        contractViolations: [],
      };
    });

    // 5. Second re-verification -> Pass
    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'APPROVE',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Full reconciliation',
              result: 'PASS',
              evidence: 'All resolved',
            },
          ],
          findings: [],
        }),
      });
      return {
        id: 'inv-5' as AgentInvocationId,
        runId: ctx.runUuid as RunId,
        phaseId: PhaseName('architecture-review'),
        profile: AgentProfileName(reviewerProfile),
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        startedAt: new Date(),
        endedAt: new Date(),
        startCommitSha: 'sha123',
        exitCode: 0,
        durationMs: 100,
        timeoutMs: 1000,
        outcome: 'success',
        contractViolations: [],
      };
    });

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('passed');

    const finalDesign = await ctx.artifacts.read(ctx.runUuid, 'design.md');
    expect(finalDesign).toContain('Resolved gap 1 and gap 2.');

    expect(eventsOf(ctx, 'architecture_review.findings_found')).toHaveLength(2);
    expect(eventsOf(ctx, 'architecture_review.verification_started')).toHaveLength(2);
    expect(eventsOf(ctx, 'architecture_review.completed')).toHaveLength(1);
  });
});

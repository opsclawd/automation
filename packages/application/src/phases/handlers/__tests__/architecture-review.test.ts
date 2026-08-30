import { describe, it, expect, vi } from 'vitest';
import { ArchitectureReviewHandler } from '../architecture-review.js';
import {
  PhaseName,
  AgentProfileName,
  type AgentInvocation,
  type AgentInvocationId,
  type RunId,
} from '@ai-sdlc/domain';
import {
  FakeArtifactStore,
  FakeAgentPort,
  FakeGitPort,
  FakeGitHubPort,
} from '../../../test-doubles/index.js';
import type { PhaseHandlerContext } from '../../handler.js';

const { mockLoadPromptTemplate, mockRenderPrompt } = vi.hoisted(() => ({
  mockLoadPromptTemplate: vi.fn(() => '# Template\n'),
  mockRenderPrompt: vi.fn(async () => '# Rendered Prompt\n'),
}));

vi.mock('../../../prompts/load-prompt-template.js', () => ({
  loadPromptTemplate: mockLoadPromptTemplate,
}));

vi.mock('../../../prompts/render-prompt.js', () => ({
  renderPrompt: mockRenderPrompt,
}));

describe('ArchitectureReviewHandler', () => {
  const createTestContext = (overrides: Partial<PhaseHandlerContext> = {}): PhaseHandlerContext => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const github = new FakeGitHubPort();

    const cwd = '/tmp/repo';
    const expectedBranch = 'main';
    const startCommitSha = 'sha123';

    git.currentBranchByCwd.set(cwd, expectedBranch);
    git.headByCwd.set(cwd, startCommitSha);

    return {
      runUuid: 'test-run-1122',
      issueNumber: 1122,
      repoFullName: 'test-org/test-repo',
      cwd,
      executionPolicy: 'strict',
      startCommitSha,
      expectedBranch,
      promptsRoot: '/tmp/prompts',
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

  it('passes on initial review when reviewer approves with no blocking findings', async () => {
    const handler = new ArchitectureReviewHandler();
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1122\nRequirements description.',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1122\nAnchored design details.',
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
          requirements_checks: [{ requirement: 'Requirements reconciliation', result: 'PASS' }],
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

    const persistedReview = await ctx.artifacts.read(ctx.runUuid, 'architecture-review.json');
    expect(JSON.parse(persistedReview).verdict).toBe('APPROVE');
  });

  it('invokes targeted planner correction and passes when re-verification succeeds', async () => {
    const handler = new ArchitectureReviewHandler();
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1122\nRequirements description.',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1122\nInitial design missing contract.',
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
            { requirement: 'Contract conservation', result: 'FAIL', evidence: 'Missing field x' },
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
          design_md: '# Design 1122\nCorrected design including field x.',
          plan_md:
            '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: do setup with field x\n- Invariants: none\n- Verification: `pnpm test`\n',
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

    // 3. Verification Pass -> APPROVE
    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'APPROVE',
          requirements_checks: [
            { requirement: 'Contract conservation', result: 'PASS', evidence: 'Field x added' },
          ],
          findings: [],
          summary: 'All findings resolved.',
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
    expect(updatedDesign).toContain('Corrected design including field x.');

    const updatedPlan = await ctx.artifacts.read(ctx.runUuid, 'plan.md');
    expect(updatedPlan).toContain('do setup with field x');
  });

  it('escalates to needs_human_review when re-verification fails (maxCorrections: 1)', async () => {
    const handler = new ArchitectureReviewHandler({ maxCorrections: 1 });
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1122\nRequirements description.',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1122\nFlawed design.',
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
          findings: [
            {
              category: 'invariant_completeness',
              severity: 'critical',
              evidence: 'Unchecked transition',
              rationale: 'Breaks state machine',
              minimal_correction: 'Add transition guard',
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

    // 2. Planner Correction
    agent.enqueue(plannerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          design_md: '# Design 1122\nAttempted fix.',
          plan_md:
            '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: do setup\n- Invariants: none\n- Verification: `pnpm test`\n',
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

    // 3. Re-verification -> still REQUEST_CHANGES
    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          findings: [
            {
              category: 'invariant_completeness',
              severity: 'critical',
              evidence: 'Transition guard still missing',
              rationale: 'Unresolved',
              minimal_correction: 'Add transition guard',
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
    expect(eventsOf(ctx, 'architecture_review.completed')).toHaveLength(0);
    if (result.outcome === 'needs_human_review') {
      expect(result.failure.kind).toBe('needs_human_review');
      expect(result.failure.message).toContain('Architecture review did not converge');
    }
  });

  it('escalates immediately to needs_human_review when maxCorrections is 0 and review has findings', async () => {
    const handler = new ArchitectureReviewHandler({ maxCorrections: 0 });
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1122\nRequirements description.',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1122\nFlawed design.',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents:
        '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: do setup\n- Invariants: none\n- Verification: `pnpm test`\n',
    });

    const agent = ctx.agent as FakeAgentPort;
    const reviewerProfile = 'profile-for-architecture-review';

    // 1. Initial Review -> REQUEST_CHANGES
    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          findings: [
            {
              category: 'invariant_completeness',
              severity: 'critical',
              evidence: 'Missing transition guard',
              rationale: 'Breaks state machine',
              minimal_correction: 'Add transition guard',
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
    if (result.outcome === 'needs_human_review') {
      expect(result.failure.kind).toBe('needs_human_review');
      expect(result.failure.message).toContain('maxCorrections is 0');
    }
  });

  it('supports multiple corrections (maxCorrections: 2) and succeeds when second verification passes', async () => {
    const handler = new ArchitectureReviewHandler({ maxCorrections: 2 });
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1122\nRequirements description.',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1122\nInitial flawed design.',
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

    const makeInv = (profile: string, id: string): AgentInvocation => ({
      id: id as AgentInvocationId,
      runId: ctx.runUuid as RunId,
      phaseId: PhaseName('architecture-review'),
      profile: AgentProfileName(profile),
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
    });

    // 1. Initial Review -> REQUEST_CHANGES (Finding 1 & 2)
    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          requirements_checks: [
            { requirement: 'Requirement A', result: 'PASS', evidence: 'Present' },
            { requirement: 'Requirement B', result: 'FAIL', evidence: 'Missing B' },
          ],
          findings: [
            {
              category: 'contract_conservation',
              severity: 'high',
              evidence: 'Missing field x',
              rationale: 'Required by consumer',
              minimal_correction: 'Add field x',
              blocking: true,
            },
          ],
        }),
      });
      return makeInv(reviewerProfile, 'inv-1');
    });

    // 2. Correction 1: Planner fixes field x but still misses Requirement B
    agent.enqueue(plannerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          design_md: '# Design 1122\nAdded field x.',
          plan_md:
            '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: setup with field x\n- Invariants: none\n- Verification: `pnpm test`\n',
        }),
      });
      return makeInv(plannerProfile, 'inv-2');
    });

    // 3. Verification 1 -> still REQUEST_CHANGES (Requirement B still failing)
    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          requirements_checks: [
            { requirement: 'Requirement A', result: 'PASS', evidence: 'Present' },
            { requirement: 'Requirement B', result: 'FAIL', evidence: 'Still missing B' },
          ],
          findings: [],
        }),
      });
      return makeInv(reviewerProfile, 'inv-3');
    });

    // 4. Correction 2: Planner fixes Requirement B
    agent.enqueue(plannerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          design_md: '# Design 1122\nAdded field x and resolved Requirement B.',
          plan_md:
            '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: setup with field x and B\n- Invariants: none\n- Verification: `pnpm test`\n',
        }),
      });
      return makeInv(plannerProfile, 'inv-4');
    });

    // 5. Verification 2 -> APPROVE!
    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'APPROVE',
          requirements_checks: [
            { requirement: 'Requirement A', result: 'PASS', evidence: 'Present' },
            { requirement: 'Requirement B', result: 'PASS', evidence: 'Resolved' },
          ],
          findings: [],
        }),
      });
      return makeInv(reviewerProfile, 'inv-5');
    });

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('passed');

    const finalDesign = await ctx.artifacts.read(ctx.runUuid, 'design.md');
    expect(finalDesign).toContain('resolved Requirement B');
  });

  it('rejects APPROVE verdict if requirements_checks contains a FAIL and triggers correction pass', async () => {
    const handler = new ArchitectureReviewHandler();
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1122\nRequirements description.',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1122\nInitial design missing requirement.',
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

    // 1. Initial Review -> APPROVE verdict but requirement check failed!
    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'APPROVE',
          requirements_checks: [
            { requirement: 'Persist executed timeline', result: 'FAIL', evidence: 'Not in design' },
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

    // 2. Targeted Planner Correction
    agent.enqueue(plannerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          design_md: '# Design 1122\nAdded timeline persistence.',
          plan_md:
            '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: persist timeline\n- Invariants: none\n- Verification: `pnpm test`\n',
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

    // 3. Re-verification -> APPROVE with all requirements PASS
    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'APPROVE',
          requirements_checks: [
            { requirement: 'Persist executed timeline', result: 'PASS', evidence: 'Now present' },
          ],
          findings: [],
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
  });
});

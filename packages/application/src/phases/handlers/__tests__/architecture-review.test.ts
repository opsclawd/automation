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

  it('rejects approval when reviewer falsely returns APPROVE claiming profile identity proves measured provenance (#129 failure mode)', async () => {
    const handler = new ArchitectureReviewHandler({ maxCorrections: 0 });
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents:
        '# Issue 1129\n## Acceptance criteria\n- [ ] Provide executed and measured provenance\n',
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

    // Mock reviewer confidently returns APPROVE with the exact false reasoning from comfy #129
    agent.enqueue(reviewerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'APPROVE',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Provide executed and measured provenance',
              result: 'PASS',
              evidence: 'The versioned assembly profile identifies the encoding contract',
            },
          ],
          witness_scenarios: [],
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

  it('rejects approval when duplicate ledger IDs appear in reviewer output', async () => {
    const handler = new ArchitectureReviewHandler({ maxCorrections: 0 });
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents:
        '# Issue 1129\n## Acceptance criteria\n- [ ] First requirement\n- [ ] Second requirement\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design\nContract design.',
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
            {
              requirement_id: 'AC-1',
              requirement: 'First requirement',
              result: 'PASS',
            },
            {
              requirement_id: 'AC-1', // Duplicate AC-1 instead of AC-2
              requirement: 'Second requirement with duplicate ID',
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

  it('rejects approval when direct consumer requirements lack specific witness scenario coverage', async () => {
    const handler = new ArchitectureReviewHandler({ maxCorrections: 0 });
    const ctx = createTestContext();

    const github = ctx.github as FakeGitHubPort;
    github.issues.set('test-org/test-repo/128', {
      number: 128,
      title: 'Soundbed Looping Consumer',
      body: 'Depends on #1129\n## Acceptance criteria\n- [ ] Soundbed 12s to 30s looping',
      labels: [],
    });
    github.issues.set('test-org/test-repo/129', {
      number: 129,
      title: 'Subtitle Styles Consumer',
      body: 'Depends on #1129\n## Acceptance criteria\n- [ ] Subtitle style cues reconstruction',
      labels: [],
    });

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents:
        '# Issue 1129\nDirect consumer: #128\nDirect consumer: #129\n## Acceptance criteria\n- [ ] Base provider interface\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design\nBase interface.',
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
            { requirement_id: 'AC-1', requirement: 'Base provider interface', result: 'PASS' },
            {
              requirement_id: 'CONSUMER-128-AC-1',
              requirement: 'Soundbed 12s to 30s looping',
              result: 'PASS',
            },
            {
              requirement_id: 'CONSUMER-129-AC-1',
              requirement: 'Subtitle style cues reconstruction',
              result: 'PASS',
            },
          ],
          // Only covers 129, 128 is omitted from witness scenarios!
          witness_scenarios: [
            {
              requirement_ids: ['CONSUMER-129-AC-1'],
              scenario: 'Subtitle cues font reconstruction',
              result: 'PASS',
              evidence: 'Cues match target font style',
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

  it('retries the correction attempt (does not escalate) when the deterministic plan check fails on a malformed corrected plan, and still succeeds within budget (regression: issue-157 run 2026-09-05, unclosed code fence)', async () => {
    const handler = new ArchitectureReviewHandler({ maxCorrections: 2 });
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 157\n## Acceptance criteria\n- [ ] Full reconciliation\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 157\nInitial design.',
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

    // 2. First Planner fix -> corrected plan has an unclosed code fence
    agent.enqueue(plannerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          design_md: '# Design 157\nAttempted fix.',
          plan_md:
            '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: fix gap 1\n- Invariants: none\n- Verification:\n```pnpm test\n',
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

    // 3. Second Planner fix -> corrected plan is well-formed this time
    agent.enqueue(plannerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          design_md: '# Design 157\nResolved gap 1.',
          plan_md:
            '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: fix gap 1\n- Invariants: none\n- Verification: `pnpm test`\n',
        }),
      });
      return {
        id: 'inv-3' as AgentInvocationId,
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

    // 4. Re-verification -> Pass. Note this is the reviewer's *second*
    // enqueued response overall but only the *first* re-verification --
    // no re-verification agent call happens for the failed first
    // correction attempt, since the deterministic check rejects that
    // corrected plan before the loop body ever reaches the
    // re-verification step.
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
              evidence: 'Resolved',
            },
          ],
          findings: [],
        }),
      });
      return {
        id: 'inv-4' as AgentInvocationId,
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

    // The malformed first correction's design.md must never have been
    // persisted as authoritative -- only the second (valid) correction's
    // content should have landed.
    const finalDesign = await ctx.artifacts.read(ctx.runUuid, 'design.md');
    expect(finalDesign).toContain('Resolved gap 1.');
    expect(finalDesign).not.toContain('Attempted fix.');

    expect(eventsOf(ctx, 'architecture_review.plan_check_failed')).toHaveLength(1);
    // Only one re-verification pass ever ran (for the second, valid
    // correction) -- confirms the retry did not also waste a
    // re-verification agent call on the rejected first attempt.
    expect(eventsOf(ctx, 'architecture_review.verification_started')).toHaveLength(1);
    expect(eventsOf(ctx, 'architecture_review.completed')).toHaveLength(1);
  });

  it('retries (does not escalate) when the targeted planner correction agent invocation itself fails, and still succeeds within budget', async () => {
    const handler = new ArchitectureReviewHandler({ maxCorrections: 2 });
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 157\n## Acceptance criteria\n- [ ] Full reconciliation\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 157\nInitial design.',
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

    // 2. First planner-fix invocation -> throws (simulated crash/timeout/provider hiccup)
    agent.enqueue(plannerProfile, async () => {
      throw new Error('simulated provider hiccup');
    });

    // 3. Second planner-fix invocation -> succeeds with a valid correction
    agent.enqueue(plannerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          design_md: '# Design 157\nResolved gap 1.',
          plan_md:
            '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: fix gap 1\n- Invariants: none\n- Verification: `pnpm test`\n',
        }),
      });
      return {
        id: 'inv-3' as AgentInvocationId,
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

    // 4. Re-verification -> Pass
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
              evidence: 'Resolved',
            },
          ],
          findings: [],
        }),
      });
      return {
        id: 'inv-4' as AgentInvocationId,
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
    expect(eventsOf(ctx, 'architecture_review.fix_failed')).toHaveLength(1);
    expect(eventsOf(ctx, 'architecture_review.completed')).toHaveLength(1);
  });

  it('retries (does not escalate) when the re-verification agent invocation itself fails, and still succeeds within budget', async () => {
    const handler = new ArchitectureReviewHandler({ maxCorrections: 2 });
    const ctx = createTestContext();

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 157\n## Acceptance criteria\n- [ ] Full reconciliation\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 157\nInitial design.',
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

    // 2. First planner-fix -> valid correction
    agent.enqueue(plannerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          design_md: '# Design 157\nAttempted fix.',
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

    // 3. First re-verification invocation -> throws (simulated crash/timeout)
    agent.enqueue(reviewerProfile, async () => {
      throw new Error('simulated provider hiccup');
    });

    // 4. Second planner-fix (retry re-runs the full correction cycle) -> valid correction
    agent.enqueue(plannerProfile, async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          design_md: '# Design 157\nResolved gap 1.',
          plan_md:
            '# Implementation Plan\n\n### Task 1: Setup\n- Files: `src/index.ts`\n- Description: fix gap 1\n- Invariants: none\n- Verification: `pnpm test`\n',
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
              evidence: 'Resolved',
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
    expect(eventsOf(ctx, 'architecture_review.verification_failed')).toHaveLength(1);

    const finalDesign = await ctx.artifacts.read(ctx.runUuid, 'design.md');
    expect(finalDesign).toContain('Resolved gap 1.');
  });
});

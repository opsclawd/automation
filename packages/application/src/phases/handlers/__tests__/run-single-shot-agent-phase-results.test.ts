import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PhaseName, AgentProfileName, type AgentInvocationId } from '@ai-sdlc/domain';
import { runSingleShotAgentPhase } from '../run-single-shot-agent-phase.js';
import type { PhaseHandlerContext } from '../../handler.js';
import { FakeArtifactStore, FakeAgentPort, FakeGitPort } from '../../../test-doubles/index.js';
import type {
  StructuredResultRepairPort,
  StructuredResultRepairInput,
  StructuredResultRepairResult,
} from '../../../ports/structured-result-repair-port.js';
import {
  plannerPackageSchema,
  type PlannerPackage,
} from '../../../results/schemas/planner-package.js';
import type { FollowUpReviewResult } from '../../../results/schemas/follow-up-review.js';

const { mockLoadPromptTemplate, mockRenderPrompt } = vi.hoisted(() => ({
  mockLoadPromptTemplate: vi.fn(() => '# Template\n'),
  mockRenderPrompt: vi.fn(async () => '# Prompt\n'),
}));

vi.mock('../../../prompts/load-prompt-template.js', () => ({
  loadPromptTemplate: mockLoadPromptTemplate,
}));

vi.mock('../../../prompts/render-prompt.js', () => ({
  renderPrompt: mockRenderPrompt,
}));

describe('runSingleShotAgentPhase - Centralized Result Ingestion', () => {
  let artifacts: FakeArtifactStore;
  let agent: FakeAgentPort;
  let git: FakeGitPort;
  let ctx: PhaseHandlerContext;

  beforeEach(() => {
    artifacts = new FakeArtifactStore();
    agent = new FakeAgentPort();
    git = new FakeGitPort();
    git.currentBranchByCwd.set('/test/repo', 'ai/issue-1128');
    git.headByCwd.set('/test/repo', '0'.repeat(40));

    ctx = {
      runUuid: 'run-1128',
      issueNumber: 1128,
      repoFullName: 'owner/repo',
      cwd: '/test/repo',
      executionPolicy: 'standard',
      promptsRoot: '/tmp/prompts',
      startCommitSha: '0'.repeat(40),
      expectedBranch: 'ai/issue-1128',
      artifacts,
      agent,
      git,
      events: { publish: vi.fn() },
      now: () => new Date(),
      idFactory: () => 'inv-1128',
      resolveProfile: (phase) => phase as never,
    } as unknown as PhaseHandlerContext;
  });

  it('returns valid typed result directly on passed outcome', async () => {
    await artifacts.write({
      runId: 'run-1128',
      relativePath: 'result.json',
      contents: JSON.stringify({
        verdict: 'APPROVE',
        evaluations: [{ finding_id: 'f-1', resolved: true, evidence: 'fixed' }],
        new_findings: [],
        summary: 'All good',
      }),
    });

    agent.enqueue('follow-up-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    const result = await runSingleShotAgentPhase<FollowUpReviewResult>(ctx, {
      phase: PhaseName('follow-up-review'),
      profile: AgentProfileName('follow-up-review'),
      step: 'follow-up-review',
      vars: { cwd: ctx.cwd },
      agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
    });

    expect(result.outcome).toBe('passed');
    if (result.outcome === 'passed') {
      expect(result.result).toBeDefined();
      expect(result.result.verdict).toBe('APPROVE');
      expect(result.result.evaluations).toHaveLength(1);
      expect(result.result.evaluations[0]?.finding_id).toBe('f-1');
    }
  });

  it('tolerates and normalizes control-character serialization defect from #1127', async () => {
    // Contains unescaped raw newline inside summary string literal
    const rawWithControlChar =
      '{\n' +
      '  "verdict": "APPROVE",\n' +
      '  "evaluations": [],\n' +
      '  "new_findings": [],\n' +
      '  "summary": "No new blocking defect was found.\n"\n' +
      '}\n';

    await artifacts.write({
      runId: 'run-1128',
      relativePath: 'result.json',
      contents: rawWithControlChar,
    });

    agent.enqueue('follow-up-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    const result = await runSingleShotAgentPhase<FollowUpReviewResult>(ctx, {
      phase: PhaseName('follow-up-review'),
      profile: AgentProfileName('follow-up-review'),
      step: 'follow-up-review',
      vars: { cwd: ctx.cwd },
      agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
    });

    expect(result.outcome).toBe('passed');
    if (result.outcome === 'passed') {
      expect(result.result.verdict).toBe('APPROVE');
      expect(result.result.summary).toContain('No new blocking defect was found.');
    }
  });

  it('fails with invalid_result when agent output is schema-invalid', async () => {
    // Invalid verdict value and invalid evaluation shape
    await artifacts.write({
      runId: 'run-1128',
      relativePath: 'result.json',
      contents: JSON.stringify({
        verdict: 'INVALID_VERDICT',
        evaluations: [{ finding_id: 123, resolved: 'not-a-bool' }],
      }),
    });

    agent.enqueue('follow-up-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    const result = await runSingleShotAgentPhase<FollowUpReviewResult>(ctx, {
      phase: PhaseName('follow-up-review'),
      profile: AgentProfileName('follow-up-review'),
      step: 'follow-up-review',
      vars: { cwd: ctx.cwd },
      agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
    });

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('invalid_result');
      expect(result.failure.message).toContain('Result extraction failed');
    }
  });

  it('fails with invalid_result when agent output is unrecoverable malformed JSON', async () => {
    await artifacts.write({
      runId: 'run-1128',
      relativePath: 'result.json',
      contents: '{ not valid json at all ::::',
    });

    agent.enqueue('follow-up-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    const result = await runSingleShotAgentPhase<FollowUpReviewResult>(ctx, {
      phase: PhaseName('follow-up-review'),
      profile: AgentProfileName('follow-up-review'),
      step: 'follow-up-review',
      vars: { cwd: ctx.cwd },
      agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
    });

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('invalid_result');
      expect(result.failure.message).toContain('JSON.parse failed');
    }
  });

  it('uses resultMeta override when provided in SingleShotConfig', async () => {
    // In architecture-fix step, the phase is 'architecture-review' but the output schema is PlannerPackage
    await artifacts.write({
      runId: 'run-1128',
      relativePath: 'result.json',
      contents: JSON.stringify({
        design_md: '# Custom Design',
        plan_md: '# Custom Plan\n\n## Task 1: Do it',
        summary: 'Planner package generated',
      }),
    });

    agent.enqueue('architecture-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    const result = await runSingleShotAgentPhase<PlannerPackage>(ctx, {
      phase: PhaseName('architecture-review'),
      profile: AgentProfileName('architecture-review'),
      step: 'architecture-fix',
      vars: { cwd: ctx.cwd },
      agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
      resultMeta: {
        schema: plannerPackageSchema,
        schemaContractText: '{\n  "design_md": string,\n  "plan_md": string\n}',
      },
    });

    expect(result.outcome).toBe('passed');
    if (result.outcome === 'passed') {
      expect(result.result.design_md).toBe('# Custom Design');
      expect(result.result.plan_md).toContain('## Task 1: Do it');
    }
  });

  it('suppresses completion event when skipCompletedEmit is true', async () => {
    await artifacts.write({
      runId: 'run-1128',
      relativePath: 'result.json',
      contents: JSON.stringify({
        verdict: 'APPROVE',
        evaluations: [],
        new_findings: [],
        summary: 'All good',
      }),
    });

    agent.enqueue('follow-up-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    const result = await runSingleShotAgentPhase<FollowUpReviewResult>(ctx, {
      phase: PhaseName('follow-up-review'),
      profile: AgentProfileName('follow-up-review'),
      step: 'follow-up-review',
      vars: { cwd: ctx.cwd },
      agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
      skipCompletedEmit: true,
    });

    expect(result.outcome).toBe('passed');
    const publishedEvents = (ctx.events.publish as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const completedEvents = publishedEvents.filter(
      (call) => (call[0] as { name?: string })?.name === 'follow-up-review.completed',
    );
    expect(completedEvents).toHaveLength(0);
  });

  it('exercises structured-result repair through centralized extraction when repair port is available', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'run-single-shot-repair-test-'));
    const stdoutPath = join(tempDir, 'stdout.log');
    writeFileSync(
      stdoutPath,
      'evidence: {"verdict": "APPROVE", "evaluations": [], "new_findings": []}\n',
    );

    try {
      // Initial result is invalid JSON
      await artifacts.write({
        runId: 'run-1128',
        relativePath: 'result.json',
        contents: '```json\n{"verdict": "APPROVE", "evaluations": [], "new_findings": []}\n```',
      });

      let repairCalled = false;
      const repairPort: StructuredResultRepairPort = {
        repairStructuredResult: async (
          params: StructuredResultRepairInput,
        ): Promise<StructuredResultRepairResult> => {
          repairCalled = true;
          // Repair fixes the artifact in artifact store
          await artifacts.write({
            runId: params.runId,
            relativePath: params.destination,
            contents: JSON.stringify({
              verdict: 'APPROVE',
              evaluations: [{ finding_id: 'repaired-1', resolved: true, evidence: 'repaired' }],
              new_findings: [],
              summary: 'Repaired successfully',
            }),
          });
          return {
            outcome: 'repaired',
            repairInvocationId: 'inv-repair-1' as AgentInvocationId,
          };
        },
      };

      (ctx as unknown as { repair: StructuredResultRepairPort }).repair = repairPort;

      agent.enqueue('follow-up-review', () => ({
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath,
        stderrPath: '/tmp/stderr',
        resultJsonPath: 'result.json',
        contractViolations: [],
        outcome: 'success',
      }));

      const result = await runSingleShotAgentPhase<FollowUpReviewResult>(ctx, {
        phase: PhaseName('follow-up-review'),
        profile: AgentProfileName('follow-up-review'),
        step: 'follow-up-review',
        vars: { cwd: ctx.cwd },
        agentContract: { requiredArtifacts: [], mustNotChangeBranch: true },
      });

      expect(repairCalled).toBe(true);
      expect(result.outcome).toBe('passed');
      if (result.outcome === 'passed') {
        expect(result.result.evaluations[0]?.finding_id).toBe('repaired-1');
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FollowUpReviewHandler } from '../follow-up-review.js';
import { FixReviewHandler } from '../fix-review.js';
import { FixValidateHandler } from '../fix-validate.js';
import type { PhaseHandlerContext } from '../../handler.js';
import { FakeArtifactStore, FakeAgentPort, FakeGitPort } from '../../../test-doubles/index.js';
import { PhaseName } from '@ai-sdlc/domain';
import { createFindingLedger } from '../../../review-fix/finding-ledger.js';
import { recordValidationEvidence } from '../../validation-evidence.js';

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

describe('Cross-phase result schema isolation (#1158)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cross-phase-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  const createMockContext = (
    artifacts: FakeArtifactStore,
    agent: FakeAgentPort,
    git: FakeGitPort,
  ): PhaseHandlerContext => {
    git.currentBranchByCwd.set(tempDir, 'ai/issue-1158');
    git.headByCwd.set(tempDir, '0'.repeat(40));
    return {
      runUuid: 'run-1158',
      issueNumber: 1158,
      repoFullName: 'owner/repo',
      cwd: tempDir,
      executionPolicy: 'standard',
      promptsRoot: '/tmp',
      startCommitSha: '0'.repeat(40),
      expectedBranch: 'ai/issue-1158',
      artifacts,
      agent,
      git,
      events: { publish: vi.fn() },
      now: () => new Date(),
      idFactory: () => 'inv-1',
      resolveProfile: (phase) => phase as never,
    } as unknown as PhaseHandlerContext;
  };

  it('runs follow-up-review and fix-review back-to-back without schema confusion', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await recordValidationEvidence(ctx, 'validate');

    await artifacts.write({
      runId: 'run-1158',
      phaseId: PhaseName('read_issue'),
      relativePath: 'issue.md',
      contents: '# Issue 1158',
    });

    const initialLedger = createFindingLedger([
      {
        severity: 'high',
        files: ['src/app.ts'],
        evidence: 'type mismatch',
        rationale: 'risk',
        minimal_correction: 'fix type',
      },
    ]);
    const findingId = initialLedger.entries[0]!.id;

    await artifacts.write({
      runId: 'run-1158',
      phaseId: PhaseName('spec-review'),
      relativePath: 'finding-ledger.json',
      contents: JSON.stringify(initialLedger),
    });

    // 1. Follow-up review runs and requests changes
    agent.enqueue('follow-up-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'follow-up-review-result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    await artifacts.write({
      runId: 'run-1158',
      relativePath: 'follow-up-review-result.json',
      contents: JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        evaluations: [
          {
            finding_id: findingId,
            resolved: false,
            evidence: 'not fixed yet',
          },
        ],
        new_findings: [],
        summary: 'Changes requested.',
      }),
    });

    const followUpHandler = new FollowUpReviewHandler();
    const followUpResult = await followUpHandler.run(ctx);
    expect(followUpResult.outcome).toBe('passed');
    expect(agent.invocations[0]?.resultJsonPath).toBe('follow-up-review-result.json');

    // 2. Fix-review runs immediately after in the same worktree
    agent.enqueue('fix-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'fix-review-result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    await artifacts.write({
      runId: 'run-1158',
      relativePath: 'fix-review-result.json',
      contents: JSON.stringify({
        result: 'done_with_fixes',
      }),
    });

    const fixReviewHandler = new FixReviewHandler();
    const fixReviewResult = await fixReviewHandler.run(ctx);
    expect(fixReviewResult.outcome).toBe('passed');
    expect(agent.invocations[1]?.resultJsonPath).toBe('fix-review-result.json');
  });

  it('pre-cleans stale result.json and phase-specific result before invoking agent', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await recordValidationEvidence(ctx, 'validate');
    await artifacts.write({
      runId: 'run-1158',
      relativePath: 'finding-ledger.json',
      contents: JSON.stringify(createFindingLedger([])),
    });

    // Write stale files to disk in worktree cwd
    const staleResultJson = join(tempDir, 'result.json');
    const staleFixReviewResult = join(tempDir, 'fix-review-result.json');
    writeFileSync(staleResultJson, JSON.stringify({ verdict: 'APPROVE', evaluations: [] }));
    writeFileSync(staleFixReviewResult, JSON.stringify({ result: 'cannot_fix' }));

    let cleanedAtInvocation = false;
    agent.enqueue('fix-review', () => {
      // Verify that at invocation time, both stale result files were cleaned up
      cleanedAtInvocation = !existsSync(staleResultJson) && !existsSync(staleFixReviewResult);

      // Now write fresh result to store
      artifacts.write({
        runId: 'run-1158',
        relativePath: 'fix-review-result.json',
        contents: JSON.stringify({ result: 'done_with_fixes' }),
      });

      return {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        resultJsonPath: 'fix-review-result.json',
        contractViolations: [],
        outcome: 'success',
      };
    });

    const fixReviewHandler = new FixReviewHandler();
    const result = await fixReviewHandler.run(ctx);

    expect(cleanedAtInvocation).toBe(true);
    expect(result.outcome).toBe('passed');
  });

  it('fails with missing artifact rather than union discriminator crash if stale result.json remains and phase result is missing', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await recordValidationEvidence(ctx, 'validate');
    await artifacts.write({
      runId: 'run-1158',
      relativePath: 'finding-ledger.json',
      contents: JSON.stringify(createFindingLedger([])),
    });

    // Simulate stale follow-up-review verdict left in artifacts store as result.json
    await artifacts.write({
      runId: 'run-1158',
      relativePath: 'result.json',
      contents: JSON.stringify({ verdict: 'APPROVE', evaluations: [] }),
    });

    // Fixer succeeds as a process but produces no fix-review-result.json artifact
    agent.enqueue('fix-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'fix-review-result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    const fixReviewHandler = new FixReviewHandler();
    const result = await fixReviewHandler.run(ctx);

    // Must NOT crash or fail with invalid_union_discriminator from parsing result.json;
    // it must fail because the required artifact fix-review-result.json is missing.
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('invalid_result');
      expect(result.failure.message).toContain('fix-review-result.json');
    }
  });

  it('configures fix-validate with fix-validate-result.json resultJsonPath', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await artifacts.write({
      runId: 'run-1158',
      relativePath: 'validate/failure.json',
      contents: JSON.stringify({ summary: 'Type error' }),
    });

    agent.enqueue('fix-validate', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'fix-validate-result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    const fixValidateHandler = new FixValidateHandler();
    await fixValidateHandler.run(ctx);

    expect(agent.invocations[0]?.resultJsonPath).toBe('fix-validate-result.json');
  });
});

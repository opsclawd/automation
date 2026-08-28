import { describe, it, expect, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ImplementHandler } from '../implement.js';
import { ValidateHandler } from '../validate.js';
import { ReviewFixHandler } from '../review-fix.js';
import { CompoundHandler } from '../compound.js';
import { CreatePrHandler } from '../create-pr.js';
import { RunValidation } from '../../../run-validation.js';
import {
  FakeAgentPort,
  FakeArtifactStore,
  FakeGitPort,
  FakeGitHubPort,
  FakeStepRepository,
  FakeValidationPort,
  FakeValidationRunRepository,
} from '../../../test-doubles/index.js';
import type { PhaseHandlerContext } from '../../handler.js';
const { mockLoadPromptTemplate, mockRenderPrompt } = vi.hoisted(() => ({
  mockLoadPromptTemplate: vi.fn<[string, string, { promptsRoot: string }], string>(
    () => '# Prompt template\n',
  ),
  mockRenderPrompt: vi.fn<
    [
      string,
      {
        runId: string;
        vars: Record<string, string>;
        artifacts: PhaseHandlerContext['artifacts'];
      },
    ],
    Promise<string>
  >(async () => '# Rendered prompt\n'),
}));

vi.mock('../../../prompts/load-prompt-template.js', () => ({
  loadPromptTemplate: mockLoadPromptTemplate,
}));

vi.mock('../../../prompts/render-prompt.js', () => ({
  renderPrompt: mockRenderPrompt,
}));

function makeSuccessAgentResult(overrides?: Partial<AgentInvocationResult>): AgentInvocationResult {
  return {
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
    ...overrides,
  };
}

describe('Lean End-to-End Phase Sequence (Issue #1103)', () => {
  it('executes implement -> validate -> review -> compound -> create-pr with control-plane commit and revalidation', async () => {
    const runUuid = '11111111-2222-3333-4444-555555555555';
    const cwd = '/tmp/repo-worktree';
    const baseSha = '0'.repeat(40);

    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const github = new FakeGitHubPort();
    const agent = new FakeAgentPort();
    const validationPort = new FakeValidationPort();
    const steps = new FakeStepRepository();
    const events: OrchestratorEvent[] = [];

    git.headByCwd.set(cwd, baseSha);
    git.currentBranchByCwd.set(cwd, 'ai/issue-1103');

    github.issues.set('opsclawd/automation/1103', {
      number: 1103,
      title: 'Simplify lean prompts and move commits to control plane',
      body: 'Authoritative issue requirements',
      labels: [],
    });

    const ctx: PhaseHandlerContext = {
      runId: 'run-1103',
      runUuid,
      repoFullName: 'opsclawd/automation',
      issueNumber: 1103,
      cwd,
      artifacts,
      github,
      git,
      agent,
      events: {
        publish: (_u: string, e: OrchestratorEvent) => events.push(e),
        subscribe: () => () => {},
      },
      now: () => new Date('2026-08-28T16:00:00Z'),
      executionPolicy: 'standard',
      startCommitSha: baseSha,
      baseBranch: 'main',
      expectedBranch: 'ai/issue-1103',
      promptsRoot: '/tmp/prompts',
      resolveProfile: () => 'opencode-frontier',
      idFactory: () => 'inv-1103',
    } as unknown as PhaseHandlerContext;

    // Issue intake artifacts
    await artifacts.write({
      runId: runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1103\nRequirements.\n',
    });
    await artifacts.write({
      runId: runUuid,
      relativePath: 'issue-comments.md',
      contents: '# Comments\nNone.\n',
    });

    // Planning artifacts
    await artifacts.write({
      runId: runUuid,
      relativePath: 'plan.md',
      contents: '# Plan\nImplement auth feature.\n',
    });
    await artifacts.write({
      runId: runUuid,
      relativePath: 'design.md',
      contents: '# Design\nDesign auth service.\n',
    });

    // ── 1. Implement Phase ──
    agent.enqueue('opencode-frontier', () => {
      // Agent edits files in the worktree and does NOT create a git commit
      git.statusByCwd.set(
        cwd,
        ' M packages/application/src/auth.ts\n?? packages/application/test/auth.test.ts\n',
      );
      return makeSuccessAgentResult();
    });

    await artifacts.write({
      runId: runUuid,
      phaseId: 'implement',
      relativePath: 'implementation-log.md',
      contents: 'Status: DONE\nImplemented auth and tests.\n',
    });

    const implementHandler = new ImplementHandler({
      steps,
      runStep: vi.fn(),
    });
    const implementResult = await implementHandler.run(ctx);
    expect(implementResult.outcome).toBe('passed');
    expect(git.headByCwd.get(cwd)).toBe(baseSha); // No commit created by agent

    // ── 2. Validate Phase ──
    validationPort.result = [
      {
        command: 'pnpm test',
        exitCode: 0,
        durationMs: 1500,
        stdout: 'Tests passed',
        stderr: '',
        stdoutPath: 'validate/0.stdout.log',
        stderrPath: 'validate/0.stderr.log',
        outcome: 'passed',
      },
    ];

    const runValidation = new RunValidation({
      validation: validationPort,
      validationRunRepository: new FakeValidationRunRepository(),
      idFactory: () => 'vr-1',
      now: () => new Date('2026-08-28T16:00:00Z'),
    });

    const validateHandler = new ValidateHandler({
      runValidation,
      commands: ['pnpm test'],
      timeoutSeconds: 300,
      logDir: `${cwd}/.ai-runs/r1/validate`,
    });
    const validateResult = await validateHandler.run(ctx);
    expect(validateResult.outcome).toBe('passed');
    expect((await artifacts.read(runUuid, 'validation.result')).trim()).toBe('passed');
    expect((await artifacts.read(runUuid, 'validation.headsha')).trim()).toBe(baseSha);

    // ── 3. Review-Fix Phase ──
    agent.enqueue('opencode-frontier', () => {
      return makeSuccessAgentResult();
    });
    await artifacts.write({
      runId: runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({
        verdict: 'APPROVE',
        acceptance_criteria: [{ criterion: 'AC1', result: 'PASS', evidence: 'Verified' }],
        findings: [],
        summary: 'All requirements satisfied.',
      }),
    });
    await artifacts.write({
      runId: runUuid,
      relativePath: 'code-review.md',
      contents: '# Review\nLGTM\n',
    });

    const reviewHandler = new ReviewFixHandler({
      runValidation,
      validationCommands: ['pnpm test'],
      validationTimeout: 300,
      validationLogDir: `${cwd}/.ai-runs/r1/review-validate`,
    });
    const reviewResult = await reviewHandler.run(ctx);
    expect(reviewResult.outcome).toBe('passed');

    // ── 4. Compound Phase ──
    agent.enqueue('opencode-frontier', () => {
      return makeSuccessAgentResult();
    });
    await artifacts.write({
      runId: runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({ result: 'written', path: 'compound.md', summary: 'ok' }),
    });
    await artifacts.write({
      runId: runUuid,
      relativePath: 'compound.md',
      contents: '# Compound Learnings\n',
    });

    const compoundHandler = new CompoundHandler();
    const compoundResult = await compoundHandler.run(ctx);
    expect(compoundResult.outcome).toBe('passed');

    // ── 5. Create-PR Phase (Application-Owned Staging, Commit & Revalidation) ──
    const revalidateCalls: string[] = [];
    const createPrHandler = new CreatePrHandler({
      headBranch: () => 'ai/issue-1103',
      revalidate: {
        runValidation: {
          execute: async (input: { cwd: string }) => {
            revalidateCalls.push(input.cwd);
            return {
              passed: true,
              validationRun: { commands: [] },
            };
          },
        } as never,
        commands: ['pnpm test'],
        timeoutSeconds: 300,
        logDir: `${cwd}/.ai-runs/r1/create-pr-revalidate`,
      },
    });

    const createPrResult = await createPrHandler.run(ctx);
    expect(createPrResult.outcome).toBe('passed');

    // Verify git actions
    expect(git.addCalls).toHaveLength(1);
    expect(git.addCalls[0]?.files).toEqual([
      'packages/application/src/auth.ts',
      'packages/application/test/auth.test.ts',
    ]);
    expect(git.commits).toHaveLength(1);
    expect(git.commits[0]?.message).toBe('feat: implement issue #1103');
    const newCommitSha = git.commits[0]?.sha;

    // Verify revalidation was executed on current HEAD
    expect(revalidateCalls).toEqual([cwd]);
    expect((await artifacts.read(runUuid, 'validation.headsha')).trim()).toBe(newCommitSha);

    // Verify branch push and PR creation
    expect(git.pushes).toHaveLength(1);
    expect(git.pushes[0]?.branch).toBe('ai/issue-1103');
    expect(github.createdPrInputs).toHaveLength(1);
    expect(github.createdPrInputs[0]?.title).toBe(
      'Simplify lean prompts and move commits to control plane',
    );
  });
});

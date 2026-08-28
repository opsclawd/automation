import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveArbiterProfileName } from '../arbiter-profile.js';
import { PHASE_RESULT_REGISTRY, PHASE_NAME_MIGRATION_MAP } from '@ai-sdlc/application';
import { validateTerminalFix } from '../compose.js';
import { PhaseName, RunId } from '@ai-sdlc/domain';
import { createComposedOrchestrationHarness } from './helpers/composed-orchestration-harness.js';

describe('plan-review compose wiring', () => {
  it('resolveArbiterProfileName returns the dedicated arbiter profile', () => {
    const profile = resolveArbiterProfileName({
      arbiter: { profile: 'arbiter-claude' },
    });
    expect(profile).toBe('arbiter-claude');
  });

  it('PHASE_RESULT_REGISTRY has plan-review-arbiter entry with arbiter schema', () => {
    const entry = PHASE_RESULT_REGISTRY['plan-review-arbiter'];
    expect(entry).toBeDefined();
    expect(entry?.schema).toBeDefined();
  });

  it('PHASE_NAME_MIGRATION_MAP maps plan-review to null', () => {
    expect(PHASE_NAME_MIGRATION_MAP['plan-review']).toBeNull();
  });

  it('renders the real plan-review and plan-fix templates instead of a stub telling the agent to load them', () => {
    const composeSrc = readFileSync(
      path.join(import.meta.dirname ?? path.join(__dirname, '..'), '..', 'compose.ts'),
      'utf-8',
    );
    expect(composeSrc).not.toContain('Load prompt from prompts/plan-review/plan-review.md');
    expect(composeSrc).not.toContain('Load prompt from prompts/plan-review/plan-fix.md');

    const reviewFnMatch = composeSrc.match(
      /const planReviewRunReview[\s\S]*?(?=const planReviewRunFix)/,
    );
    expect(reviewFnMatch).toBeTruthy();
    expect(reviewFnMatch![0]).toContain("loadPromptTemplate('plan-review', 'plan-review'");
    expect(reviewFnMatch![0]).toContain('renderPrompt(template');
    expect(reviewFnMatch![0]).toContain('buildPlanReviewReviewScopeBlock');

    const fixFnMatch = composeSrc.match(/const planReviewRunFix[\s\S]*?(?=const startCommitSha)/);
    expect(fixFnMatch).toBeTruthy();
    expect(fixFnMatch![0]).toContain("loadPromptTemplate('plan-review', 'plan-fix'");
    expect(fixFnMatch![0]).toContain('renderPrompt(template');
  });

  it('planReviewRunReview parses the findings markdown with parsePlanReviewFindings', () => {
    const composeSrc = readFileSync(
      path.join(import.meta.dirname ?? path.join(__dirname, '..'), '..', 'compose.ts'),
      'utf-8',
    );
    const reviewFnMatch = composeSrc.match(
      /const planReviewRunReview[\s\S]*?(?=const planReviewRunFix)/,
    );
    expect(reviewFnMatch).toBeTruthy();
    expect(reviewFnMatch![0]).toContain('parsePlanReviewFindings(findings');
    expect(reviewFnMatch![0]).toContain('planReviewDeltaScopedReReview');
    expect(reviewFnMatch![0]).toContain('parsedFindings.findings');
    expect(reviewFnMatch![0]).toContain('parsedFindings.knownLimitations');
    expect(reviewFnMatch![0]).toContain('rmSync(join(ctx.cwd, PLAN_REVIEW_FINDINGS_ARTIFACT)');
    expect(reviewFnMatch![0]).toContain('buildPlanReviewValidationErrorBlock');
    expect(reviewFnMatch![0]).toContain(
      'validationError: error instanceof Error ? error.message : String(error)',
    );
  });

  it('captures only findings validation exceptions as retry feedback', () => {
    const composeSrc = readFileSync(
      path.join(import.meta.dirname ?? path.join(__dirname, '..'), '..', 'compose.ts'),
      'utf-8',
    );
    const reviewFnMatch = composeSrc.match(
      /const planReviewRunReview[\s\S]*?(?=const planReviewRunFix)/,
    );
    expect(reviewFnMatch).toBeTruthy();
    const fnSrc = reviewFnMatch![0];

    // Ensure ctx.metadata?.validationError is read and passed to helper
    expect(fnSrc).toContain('ctx.metadata?.validationError');
    expect(fnSrc).toContain('buildPlanReviewValidationErrorBlock(validationError)');

    // Ensure promptBody appends validationBlock if non-empty
    expect(fnSrc).toContain('if (validationBlock.length > 0)');
    expect(fnSrc).toContain('promptBody = `${promptBody}\\n\\n${validationBlock}`');

    // Ensure findings read / parse catch captures the normalized error
    expect(fnSrc).toContain('catch (error)');
    expect(fnSrc).toContain(
      'validationError: error instanceof Error ? error.message : String(error)',
    );

    // Ensure artifactAgent.invoke catch does NOT return validationError
    const invokeCatchMatch = fnSrc.match(
      /artifactAgent\.invoke[\s\S]*?catch[\s\S]*?\{([\s\S]*?)\}/,
    );
    expect(invokeCatchMatch).toBeTruthy();
    expect(invokeCatchMatch![1]).not.toContain('validationError');

    // Ensure non-success outcome return does NOT include validationError
    const nonSuccessMatch = fnSrc.match(
      /if\s*\(\s*invokeResult\.outcome\s*!==\s*'success'\s*\)\s*\{([\s\S]*?)\}/,
    );
    expect(nonSuccessMatch).toBeTruthy();
    expect(nonSuccessMatch![1]).not.toContain('validationError');
  });

  it('wires planReviewCheckDeterministicPlan into the PlanReviewLoop using validatePlanTaskList', () => {
    const composeSrc = readFileSync(
      path.join(import.meta.dirname ?? path.join(__dirname, '..'), '..', 'compose.ts'),
      'utf-8',
    );

    const checkFnMatch = composeSrc.match(
      /const planReviewCheckDeterministicPlan[\s\S]*?(?=const planReviewRunReview)/,
    );
    expect(checkFnMatch).toBeTruthy();
    expect(checkFnMatch![0]).toContain('createDeterministicPlanCheck({');
    expect(checkFnMatch![0]).toContain('validatePlanTaskList');
    expect(checkFnMatch![0]).toContain("artifacts.read(String(ctx.runId), 'plan.md')");
    expect(checkFnMatch![0]).toContain("artifacts.read(String(ctx.runId), 'task-manifest.json')");
    expect(checkFnMatch![0]).toContain('ArtifactNotFoundError');
    expect(checkFnMatch![0]).toContain('signatureAnalyzer: planReviewSignatureAnalyzer');

    const constructorMatch = composeSrc.match(/new PlanReviewLoop\({[\s\S]*?}\);/);
    expect(constructorMatch).toBeTruthy();
    expect(constructorMatch![0]).toContain(
      'checkDeterministicPlan: planReviewCheckDeterministicPlan',
    );
    expect(constructorMatch![0]).toContain('captureSnapshot');
    expect(constructorMatch![0]).toContain('computeSnapshot');
    expect(constructorMatch![0]).toContain('computeLastFixDiffCitations');
    expect(constructorMatch![0]).toContain('getRecentFixCitations');
  });

  it('planReviewRunReview appends final_full scope when options contain only mode and snapshot', () => {
    const composeSrc = readFileSync(
      path.join(import.meta.dirname ?? path.join(__dirname, '..'), '..', 'compose.ts'),
      'utf-8',
    );
    const reviewFnMatch = composeSrc.match(
      /const planReviewRunReview[\s\S]*?(?=const planReviewRunFix)/,
    );
    expect(reviewFnMatch).toBeTruthy();
    const fnSrc = reviewFnMatch![0];
    expect(fnSrc).toContain('buildPlanReviewReviewScopeBlock');
    expect(fnSrc).not.toContain(
      'reviewOpts.prevFindings !== undefined || reviewOpts.recentFixCitations !== undefined',
    );
    expect(fnSrc).toMatch(
      /if\s*\(\s*reviewOpts\s*!==\s*undefined\s*&&\s*ctx\.iterationIndex\s*>=\s*2\s*\)/,
    );
    expect(fnSrc).toMatch(/scopeBlock\.length\s*>\s*0/);
  });

  it('planReviewRunFix forwards the deterministic diagnostic in vars and sets deterministic_fix invocation_type', () => {
    const composeSrc = readFileSync(
      path.join(import.meta.dirname ?? path.join(__dirname, '..'), '..', 'compose.ts'),
      'utf-8',
    );
    const fixFnMatch = composeSrc.match(/const planReviewRunFix[\s\S]*?(?=const planReviewLoop)/);
    expect(fixFnMatch).toBeTruthy();
    expect(fixFnMatch![0]).toContain('deterministicDiagnostic: opts.deterministicDiagnostic');
    expect(fixFnMatch![0]).toContain('deterministic_fix');
  });

  it('keeps plan.md available to the plan fixer while clearing fresh outputs', () => {
    const composeSrc = readFileSync(
      path.join(import.meta.dirname ?? path.join(__dirname, '..'), '..', 'compose.ts'),
      'utf-8',
    );
    const fixFnMatch = composeSrc.match(/const planReviewRunFix[\s\S]*?(?=const planReviewLoop)/);
    expect(fixFnMatch).toBeTruthy();
    expect(fixFnMatch![0]).toContain("preserveExpectedArtifacts: ['plan.md']");
  });

  it('validateTerminalFix executes validation checks and cleans up snapshots Map', async () => {
    const ctx = {
      runId: 'test-run-123',
      cwd: '/dummy',
    } as unknown as import('@ai-sdlc/application').PlanReviewContext;

    const mockArtifacts = {
      read: async (runId: string, filePath: string) => {
        expect(runId).toBe('test-run-123');
        if (filePath === 'plan.md') return 'some plan markdown';
        if (filePath === 'task-manifest.json') return '{"version": 1}';
        throw new Error('not found');
      },
    };

    const terminalSnapshots = new Map<string, { planMdDigest: string; manifestDigest: string }>();
    terminalSnapshots.set('test-run-123', {
      planMdDigest: 'old-plan-digest',
      manifestDigest: 'old-manifest-digest',
    });

    const parseTaskManifestMock = ((content: string) => {
      expect(content).toBe('{"version": 1}');
      return { success: false, error: 'fake manifest error' };
    }) as unknown as typeof parseTaskManifest;

    const validatePlanTaskListMock = ((plan: string, manifest?: string) => {
      expect(plan).toBe('some plan markdown');
      expect(manifest).toBe('{"version": 1}');
      return { success: false, error: 'fake validation error' };
    }) as unknown as typeof validatePlanTaskList;

    const parsePlanReviewFindingsMock = (() => {
      return {} as unknown as ReturnType<typeof parsePlanReviewFindings>;
    }) as unknown as typeof parsePlanReviewFindings;

    const result = await validateTerminalFix(ctx, {
      artifacts: mockArtifacts,
      terminalSnapshots,
      parseTaskManifest: parseTaskManifestMock,
      validatePlanTaskList: validatePlanTaskListMock,
      parsePlanReviewFindings: parsePlanReviewFindingsMock,
    });

    expect(result.passed).toBe(false);
    expect(result.diagnostics).toContain('task-manifest.json parse failure: fake manifest error');
    expect(result.diagnostics).toContain('validatePlanTaskList failure: fake validation error');
    // Verify terminalSnapshots got cleaned up
    expect(terminalSnapshots.has('test-run-123')).toBe(false);
  });

  it('validateTerminalFix cleans up snapshots Map even when an error occurs', async () => {
    const ctx = {
      runId: 'test-run-456',
      cwd: '/dummy',
    } as unknown as import('@ai-sdlc/application').PlanReviewContext;

    const mockArtifacts = {
      read: async () => {
        throw new Error('Unreadable error');
      },
    };

    const terminalSnapshots = new Map<string, { planMdDigest: string; manifestDigest: string }>();
    terminalSnapshots.set('test-run-456', {
      planMdDigest: 'old-plan-digest',
      manifestDigest: 'old-manifest-digest',
    });

    await validateTerminalFix(ctx, {
      artifacts: mockArtifacts,
      terminalSnapshots,
      parseTaskManifest: (() => {
        throw new Error('Not reached');
      }) as unknown as typeof parseTaskManifest,
      validatePlanTaskList: (() => {
        throw new Error('Not reached');
      }) as unknown as typeof validatePlanTaskList,
      parsePlanReviewFindings: (() => {
        throw new Error('Not reached');
      }) as unknown as typeof parsePlanReviewFindings,
    });

    expect(terminalSnapshots.has('test-run-456')).toBe(false);
  });

  it('computeSnapshot resolves deliverable paths using getHydratedWorktreePath for plan.md, task-manifest.json, and design.md', () => {
    const composeSrc = readFileSync(
      path.join(import.meta.dirname ?? path.join(__dirname, '..'), '..', 'compose.ts'),
      'utf-8',
    );
    const computeSnapshotMatch = composeSrc.match(
      /const computeSnapshot = async[\s\S]*?(?=const planReviewRunReview)/,
    );
    expect(computeSnapshotMatch).toBeTruthy();
    const snapshotSrc = computeSnapshotMatch![0];
    expect(snapshotSrc).toContain("getHydratedWorktreePath('plan.md')");
    expect(snapshotSrc).toContain("getHydratedWorktreePath('task-manifest.json')");
    expect(snapshotSrc).toContain("getHydratedWorktreePath('design.md')");
  });

  const planReviewAgentConfig = {
    validation: { commands: ['echo ok'], timeout: 60 },
    phases: {
      skip: [],
      planReview: { enabled: true, maxIterations: 1 },
      reviewFix: { maxIterations: 1 },
      implement: { maxIterations: 1 },
      fixValidate: { enabled: false, maxIterations: 3 },
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
    agent: {
      defaultProfile: 'test',
      profiles: {
        test: { runtime: 'opencode', provider: 'test', model: 'test', timeoutMinutes: 1 },
      },
      phaseProfiles: {
        'plan-review': { profile: 'test' },
        'plan-fix': { profile: 'test' },
        arbiter: { profile: 'test' },
        'result-writer': { profile: 'test' },
      },
    },
  };

  it('plan-review read-only guard detects mutations to .ai/plan.md and reports logical label plan.md', async () => {
    const findingsMd = `## verdict
pass

## findings
`;
    const mutatingReviewScript = {
      phaseId: 'plan-review',
      invocationType: 'initial',
      handle: async (request: { cwd: string }) => {
        writeFileSync(path.join(request.cwd, 'plan-review-findings.md'), findingsMd, 'utf-8');
        writeFileSync(path.join(request.cwd, '.ai', 'plan.md'), '# Mutated Plan\n', 'utf-8');
        return {
          runtime: 'test' as const,
          provider: 'test',
          model: 'test',
          exitCode: 0,
          durationMs: 10,
          stdout: findingsMd,
          stderrPath: '/dev/null',
          contractViolations: [],
          outcome: 'success' as const,
        };
      },
    };

    const harness = createComposedOrchestrationHarness({
      repoFullName: 'owner/test-repo',
      issueNumber: 1,
      scripts: [mutatingReviewScript],
      agentConfig: planReviewAgentConfig,
    });

    try {
      const worktreeDir = path.join(harness.targetRoot, '.ai-worktrees', 'issue-1');
      mkdirSync(path.join(worktreeDir, '.ai'), { recursive: true });

      const VALID_DESIGN_MD = '# Test Design\n';
      const VALID_PLAN_MD = '# Test Plan\n\n## Task 1: First Task\nDo the first thing.\n';
      const VALID_TASK_MANIFEST_V2 = JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [{ n: 1, title: 'First Task' }],
      });

      writeFileSync(path.join(worktreeDir, '.ai', 'design.md'), VALID_DESIGN_MD);
      writeFileSync(path.join(worktreeDir, '.ai', 'plan.md'), VALID_PLAN_MD);
      writeFileSync(path.join(worktreeDir, '.ai', 'task-manifest.json'), VALID_TASK_MANIFEST_V2);

      await harness.context.artifacts.write({
        runId: harness.run.uuid,
        relativePath: 'design.md',
        contents: VALID_DESIGN_MD,
      });
      await harness.context.artifacts.write({
        runId: harness.run.uuid,
        relativePath: 'plan.md',
        contents: VALID_PLAN_MD,
      });
      await harness.context.artifacts.write({
        runId: harness.run.uuid,
        relativePath: 'task-manifest.json',
        contents: VALID_TASK_MANIFEST_V2,
      });

      const planReviewHandler = harness.container.phaseRegistry.get(PhaseName('plan-review'));
      expect(planReviewHandler).toBeDefined();

      await planReviewHandler!.run(harness.context);

      const events = harness.container.eventRepository.listByRunSince(
        RunId(harness.run.uuid),
        new Date(0),
      );
      const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
      expect(violationEvents.length).toBeGreaterThan(0);
      expect(violationEvents[0]!.metadata.files).toContain('plan.md');
    } finally {
      harness.cleanup();
    }
  });

  it('plan-review read-only guard detects mutations to .ai/task-manifest.json and reports logical label task-manifest.json', async () => {
    const findingsMd = `## verdict
pass

## findings
`;
    const mutatingReviewScript = {
      phaseId: 'plan-review',
      invocationType: 'initial',
      handle: async (request: { cwd: string }) => {
        writeFileSync(path.join(request.cwd, 'plan-review-findings.md'), findingsMd, 'utf-8');
        writeFileSync(
          path.join(request.cwd, '.ai', 'task-manifest.json'),
          JSON.stringify({ version: 2, task_count: 99, tasks: [] }),
          'utf-8',
        );
        return {
          runtime: 'test' as const,
          provider: 'test',
          model: 'test',
          exitCode: 0,
          durationMs: 10,
          stdout: findingsMd,
          stderrPath: '/dev/null',
          contractViolations: [],
          outcome: 'success' as const,
        };
      },
    };

    const harness = createComposedOrchestrationHarness({
      repoFullName: 'owner/test-repo',
      issueNumber: 1,
      scripts: [mutatingReviewScript],
      agentConfig: planReviewAgentConfig,
    });

    try {
      const worktreeDir = path.join(harness.targetRoot, '.ai-worktrees', 'issue-1');
      mkdirSync(path.join(worktreeDir, '.ai'), { recursive: true });

      const VALID_DESIGN_MD = '# Test Design\n';
      const VALID_PLAN_MD = '# Test Plan\n\n## Task 1: First Task\nDo the first thing.\n';
      const VALID_TASK_MANIFEST_V2 = JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [{ n: 1, title: 'First Task' }],
      });

      writeFileSync(path.join(worktreeDir, '.ai', 'design.md'), VALID_DESIGN_MD);
      writeFileSync(path.join(worktreeDir, '.ai', 'plan.md'), VALID_PLAN_MD);
      writeFileSync(path.join(worktreeDir, '.ai', 'task-manifest.json'), VALID_TASK_MANIFEST_V2);

      await harness.context.artifacts.write({
        runId: harness.run.uuid,
        relativePath: 'design.md',
        contents: VALID_DESIGN_MD,
      });
      await harness.context.artifacts.write({
        runId: harness.run.uuid,
        relativePath: 'plan.md',
        contents: VALID_PLAN_MD,
      });
      await harness.context.artifacts.write({
        runId: harness.run.uuid,
        relativePath: 'task-manifest.json',
        contents: VALID_TASK_MANIFEST_V2,
      });

      const planReviewHandler = harness.container.phaseRegistry.get(PhaseName('plan-review'));
      expect(planReviewHandler).toBeDefined();

      await planReviewHandler!.run(harness.context);

      const events = harness.container.eventRepository.listByRunSince(
        RunId(harness.run.uuid),
        new Date(0),
      );
      const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
      expect(violationEvents.length).toBeGreaterThan(0);
      expect(violationEvents[0]!.metadata.files).toContain('task-manifest.json');
    } finally {
      harness.cleanup();
    }
  });

  it('plan-review read-only guard detects mutations to .ai/design.md and reports logical label design.md', async () => {
    const findingsMd = `## verdict
pass

## findings
`;
    const mutatingReviewScript = {
      phaseId: 'plan-review',
      invocationType: 'initial',
      handle: async (request: { cwd: string }) => {
        writeFileSync(path.join(request.cwd, 'plan-review-findings.md'), findingsMd, 'utf-8');
        writeFileSync(path.join(request.cwd, '.ai', 'design.md'), '# Mutated Design\n', 'utf-8');
        return {
          runtime: 'test' as const,
          provider: 'test',
          model: 'test',
          exitCode: 0,
          durationMs: 10,
          stdout: findingsMd,
          stderrPath: '/dev/null',
          contractViolations: [],
          outcome: 'success' as const,
        };
      },
    };

    const harness = createComposedOrchestrationHarness({
      repoFullName: 'owner/test-repo',
      issueNumber: 1,
      scripts: [mutatingReviewScript],
      agentConfig: planReviewAgentConfig,
    });

    try {
      const worktreeDir = path.join(harness.targetRoot, '.ai-worktrees', 'issue-1');
      mkdirSync(path.join(worktreeDir, '.ai'), { recursive: true });

      const VALID_DESIGN_MD = '# Test Design\n';
      const VALID_PLAN_MD = '# Test Plan\n\n## Task 1: First Task\nDo the first thing.\n';
      const VALID_TASK_MANIFEST_V2 = JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [{ n: 1, title: 'First Task' }],
      });

      writeFileSync(path.join(worktreeDir, '.ai', 'design.md'), VALID_DESIGN_MD);
      writeFileSync(path.join(worktreeDir, '.ai', 'plan.md'), VALID_PLAN_MD);
      writeFileSync(path.join(worktreeDir, '.ai', 'task-manifest.json'), VALID_TASK_MANIFEST_V2);

      await harness.context.artifacts.write({
        runId: harness.run.uuid,
        relativePath: 'design.md',
        contents: VALID_DESIGN_MD,
      });
      await harness.context.artifacts.write({
        runId: harness.run.uuid,
        relativePath: 'plan.md',
        contents: VALID_PLAN_MD,
      });
      await harness.context.artifacts.write({
        runId: harness.run.uuid,
        relativePath: 'task-manifest.json',
        contents: VALID_TASK_MANIFEST_V2,
      });

      const planReviewHandler = harness.container.phaseRegistry.get(PhaseName('plan-review'));
      expect(planReviewHandler).toBeDefined();

      await planReviewHandler!.run(harness.context);

      const events = harness.container.eventRepository.listByRunSince(
        RunId(harness.run.uuid),
        new Date(0),
      );
      const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
      expect(violationEvents.length).toBeGreaterThan(0);
      expect(violationEvents[0]!.metadata.files).toContain('design.md');
    } finally {
      harness.cleanup();
    }
  });
});

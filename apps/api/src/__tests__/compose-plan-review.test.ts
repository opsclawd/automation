import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveArbiterProfileName } from '../arbiter-profile.js';
import { PHASE_RESULT_REGISTRY, PHASE_NAME_MIGRATION_MAP } from '@ai-sdlc/application';
import { validateTerminalFix } from '../compose.js';

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
    expect(constructorMatch![0]).toContain('computeLastFixDiffCitations');
    expect(constructorMatch![0]).toContain('getRecentFixCitations');
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
});

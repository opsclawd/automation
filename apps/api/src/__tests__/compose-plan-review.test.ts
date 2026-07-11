import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveArbiterProfileName } from '../arbiter-profile.js';
import { PHASE_RESULT_REGISTRY, PHASE_NAME_MIGRATION_MAP } from '@ai-sdlc/application';

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

  it('wires planReviewCheckManifestSync into the PlanReviewLoop using validatePlanTaskList', () => {
    const composeSrc = readFileSync(
      path.join(import.meta.dirname ?? path.join(__dirname, '..'), '..', 'compose.ts'),
      'utf-8',
    );

    const checkFnMatch = composeSrc.match(
      /const planReviewCheckManifestSync[\s\S]*?(?=const planReviewRunReview)/,
    );
    expect(checkFnMatch).toBeTruthy();
    expect(checkFnMatch![0]).toContain('validatePlanTaskList(planMd, manifestJson)');
    expect(checkFnMatch![0]).toContain("artifacts.read(String(ctx.runId), 'plan.md')");
    expect(checkFnMatch![0]).toContain("artifacts.read(String(ctx.runId), 'task-manifest.json')");
    expect(checkFnMatch![0]).toContain('ArtifactNotFoundError');

    const constructorMatch = composeSrc.match(/new PlanReviewLoop\({[\s\S]*?}\);/);
    expect(constructorMatch).toBeTruthy();
    expect(constructorMatch![0]).toContain('checkManifestSync: planReviewCheckManifestSync');
    expect(constructorMatch![0]).toContain('computeLastFixDiffCitations');
    expect(constructorMatch![0]).toContain('getRecentFixCitations');
  });
});

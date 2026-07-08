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
    expect(entry?.retrySafe).toBe(true);
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

    const fixFnMatch = composeSrc.match(
      /const planReviewRunFix[\s\S]*?(?=const startCommitSha)/,
    );
    expect(fixFnMatch).toBeTruthy();
    expect(fixFnMatch![0]).toContain("loadPromptTemplate('plan-review', 'plan-fix'");
    expect(fixFnMatch![0]).toContain('renderPrompt(template');
  });
});

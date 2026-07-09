import { describe, it, expect } from 'vitest';
import { FakeArtifactStore } from '@ai-sdlc/application/test-doubles';
import {
  buildPlanReviewArbiterPrompt,
  readPlanReviewExcerpts,
  buildPlanReviewFinalReviewArbiterPrompt,
  readPlanReviewFinalExcerpts,
  PLAN_REVIEW_FINDINGS_ARTIFACT,
  PLAN_FIX_RESULT_ARTIFACT,
} from '../plan-review-prompts.js';

describe('buildPlanReviewArbiterPrompt', () => {
  it('includes plan, findings, and fix excerpts', () => {
    const prompt = buildPlanReviewArbiterPrompt(
      { cwd: '/wt', runId: 'run-1' },
      {
        planExcerpt: '# plan body',
        findingsExcerpt: '# findings',
        fixExcerpt: '{"verdict":"done_no_fixes_needed"}',
        fixRebuttal: 'finding is wrong',
      },
    );
    expect(prompt).toContain('plan body');
    expect(prompt).toContain('findings');
    expect(prompt).toContain('done_no_fixes_needed');
    expect(prompt).toContain('finding is wrong');
    expect(prompt).toContain('evidence');
    expect(prompt).toContain('STOP RULE');
  });

  it('emits the arbiter result.json shape', () => {
    const prompt = buildPlanReviewArbiterPrompt(
      { cwd: '/wt', runId: 'run-1' },
      { planExcerpt: '', findingsExcerpt: '', fixExcerpt: '', fixRebuttal: '' },
    );
    expect(prompt).toContain('finding_valid | finding_invalid | ambiguous | insufficient_evidence');
    expect(prompt).toContain('"outcome"');
  });
});

describe('readPlanReviewExcerpts', () => {
  it('reads all three phase-segregated artifacts', async () => {
    const store = new FakeArtifactStore();
    await store.write({ runId: 'run-1', relativePath: 'plan.md', contents: '# plan' });
    await store.write({
      runId: 'run-1',
      relativePath: PLAN_REVIEW_FINDINGS_ARTIFACT,
      contents: '# findings',
    });
    await store.write({ runId: 'run-1', relativePath: PLAN_FIX_RESULT_ARTIFACT, contents: '{}' });
    const excerpts = await readPlanReviewExcerpts(store, 'run-1');
    expect(excerpts.planExcerpt).toContain('# plan');
    expect(excerpts.findingsExcerpt).toContain('# findings');
    expect(excerpts.fixExcerpt).toContain('{}');
  });

  it('returns empty strings when artifacts are absent', async () => {
    const store = new FakeArtifactStore();
    const excerpts = await readPlanReviewExcerpts(store, 'run-1');
    expect(excerpts.planExcerpt).toBe('');
    expect(excerpts.findingsExcerpt).toBe('');
    expect(excerpts.fixExcerpt).toBe('');
  });
});

describe('buildPlanReviewFinalReviewArbiterPrompt', () => {
  it('includes plan and findings excerpts with no fixer-shaped narrative', () => {
    const prompt = buildPlanReviewFinalReviewArbiterPrompt(
      { cwd: '/wt', runId: 'run-1' },
      {
        planExcerpt: '# plan body',
        findingsExcerpt: '# trailing findings',
      },
    );
    expect(prompt).toContain('plan body');
    expect(prompt).toContain('trailing findings');
    expect(prompt).toContain('evidence');
    expect(prompt).toContain('STOP RULE');
    expect(prompt).not.toContain('done_no_fixes_needed');
    expect(prompt).not.toContain('fixExcerpt');
    expect(prompt).not.toContain('plan-fix-result.json');
    expect(prompt).not.toContain('rebuttal');
  });

  it('emits the arbiter result.json shape', () => {
    const prompt = buildPlanReviewFinalReviewArbiterPrompt(
      { cwd: '/wt', runId: 'run-1' },
      { planExcerpt: '', findingsExcerpt: '' },
    );
    expect(prompt).toContain('finding_valid | finding_invalid | ambiguous | insufficient_evidence');
    expect(prompt).toContain('"outcome"');
  });
});

describe('readPlanReviewFinalExcerpts', () => {
  it('reads plan and findings artifacts only', async () => {
    const store = new FakeArtifactStore();
    await store.write({ runId: 'run-1', relativePath: 'plan.md', contents: '# plan' });
    await store.write({
      runId: 'run-1',
      relativePath: PLAN_REVIEW_FINDINGS_ARTIFACT,
      contents: '# findings',
    });
    await store.write({
      runId: 'run-1',
      relativePath: PLAN_FIX_RESULT_ARTIFACT,
      contents: '{"stale":true}',
    });
    const excerpts = await readPlanReviewFinalExcerpts(store, 'run-1');
    expect(excerpts.planExcerpt).toContain('# plan');
    expect(excerpts.findingsExcerpt).toContain('# findings');
    expect(Object.keys(excerpts)).toEqual(['planExcerpt', 'findingsExcerpt']);
  });

  it('returns empty strings when artifacts are absent', async () => {
    const store = new FakeArtifactStore();
    const excerpts = await readPlanReviewFinalExcerpts(store, 'run-1');
    expect(excerpts.planExcerpt).toBe('');
    expect(excerpts.findingsExcerpt).toBe('');
  });
});

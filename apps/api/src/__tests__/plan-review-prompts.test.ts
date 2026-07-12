import { describe, it, expect, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import { readFileSync } from 'node:fs';
import { FakeArtifactStore } from '@ai-sdlc/application/test-doubles';
import {
  buildPlanReviewArbiterPrompt,
  buildPlanReviewFinalReviewArbiterPrompt,
  buildPlanReviewReviewPrompt,
  buildPlanReviewReviewScopeBlock,
  createPlanReviewEvidenceResolver,
  getRecentFixCitations,
  parsePlanReviewFindings,
  readPlanReviewExcerpts,
  readPlanReviewFinalExcerpts,
  PLAN_REVIEW_FINDINGS_ARTIFACT,
  PLAN_FIX_RESULT_ARTIFACT,
} from '../plan-review-prompts.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(
      (
        file: Parameters<typeof actual.execFileSync>[0],
        args: Parameters<typeof actual.execFileSync>[1],
        options: Parameters<typeof actual.execFileSync>[2],
      ) => actual.execFileSync(file, args, options),
    ),
  };
});

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
    expect(prompt).toContain('## WORKSPACE CONSTRAINTS');
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
    expect(Object.keys(excerpts)).toEqual([
      'planExcerpt',
      'findingsExcerpt',
      'fixExcerpt',
      'manifestExcerpt',
      'designExcerpt',
    ]);
  });

  it('returns empty strings when artifacts are absent', async () => {
    const store = new FakeArtifactStore();
    const excerpts = await readPlanReviewExcerpts(store, 'run-1');
    expect(excerpts.planExcerpt).toBe('');
    expect(excerpts.findingsExcerpt).toBe('');
    expect(excerpts.fixExcerpt).toBe('');
    expect(excerpts.manifestExcerpt).toBe('');
    expect(excerpts.designExcerpt).toBe('');
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
    expect(prompt).toContain('## WORKSPACE CONSTRAINTS');
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

describe('buildPlanReviewReviewPrompt', () => {
  it('appends the scoped re-review block when prior findings and recent fix citations are present', () => {
    const prompt = buildPlanReviewReviewPrompt('BASE PROMPT', {
      prevFindings: [
        {
          severity: 'P1',
          citation: 'plan.md:42',
          failureScenario: 'Missing transition handler',
          evidence: 'grounded',
        },
      ],
      recentFixCitations: ['plan.md:42', 'plan.md:50-55'],
    });

    expect(prompt.startsWith('BASE PROMPT')).toBe(true);
    expect(prompt).toContain('## SCOPE');
    expect(prompt).toContain('## DISPOSITION GUIDANCE');
    expect(prompt).toContain('## RECENT FIX CITATIONS');
    expect(prompt).toContain('`plan.md:42`');
    expect(prompt).toContain('prior evidence: grounded');
  });
});

describe('prompts/plan-review/plan-review.md', () => {
  it('requires the evidence token in the findings output schema', () => {
    const template = readFileSync(
      new URL('../../../../prompts/plan-review/plan-review.md', import.meta.url),
      'utf-8',
    );

    expect(template).toContain('grounded');
    expect(template).toContain('ungrounded');
    expect(template).toContain('evidence token');
    expect(template).toContain('still_open');
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
    expect(Object.keys(excerpts)).toEqual([
      'planExcerpt',
      'findingsExcerpt',
      'manifestExcerpt',
      'designExcerpt',
    ]);
  });

  it('returns empty strings when artifacts are absent', async () => {
    const store = new FakeArtifactStore();
    const excerpts = await readPlanReviewFinalExcerpts(store, 'run-1');
    expect(excerpts.planExcerpt).toBe('');
    expect(excerpts.findingsExcerpt).toBe('');
    expect(excerpts.manifestExcerpt).toBe('');
    expect(excerpts.designExcerpt).toBe('');
  });
});

describe('parsePlanReviewFindings (re-export)', () => {
  it('parses a passing verdict with no findings', () => {
    const md = `# Plan Review Findings

## verdict
pass

## findings
`;
    expect(() => parsePlanReviewFindings(md)).not.toThrow();
  });
});

describe('buildPlanReviewReviewScopeBlock (#716)', () => {
  it('renders SCOPE + DISPOSITION GUIDANCE + frozen findings when prevFindings is provided', () => {
    const block = buildPlanReviewReviewScopeBlock({
      prevFindings: [
        {
          severity: 'P1',
          citation: 'plan.md:42',
          failureScenario: 'Missing transition handler',
          evidence: 'grounded',
          disposition: 'still_open',
        },
      ],
    });
    expect(block).toContain('## SCOPE');
    expect(block).toContain('## DISPOSITION GUIDANCE');
    expect(block).toContain('### Frozen findings (from iteration 1)');
    expect(block).toContain('[P1] `plan.md:42`');
    expect(block).toContain('prior disposition: still_open');
    expect(block).toContain('prior evidence: grounded');
  });

  it('renders RECENT FIX CITATIONS when recentFixCitations is provided', () => {
    const block = buildPlanReviewReviewScopeBlock({
      recentFixCitations: ['plan.md:42', 'plan.md:50-55'],
    });
    expect(block).toContain('## RECENT FIX CITATIONS');
    expect(block).toContain('`plan.md:42`');
    expect(block).toContain('`plan.md:50-55`');
  });

  it('emits empty string when no opts supplied (caller will skip the suffix entirely)', () => {
    const block = buildPlanReviewReviewScopeBlock(undefined);
    expect(block).toBe('');
  });

  it('renders a minimal no-data scope block when explicit empty arrays are threaded', () => {
    const block = buildPlanReviewReviewScopeBlock({
      prevFindings: [],
      recentFixCitations: [],
    });
    expect(block).toContain('## SCOPE');
    expect(block).toContain('## DISPOSITION GUIDANCE');
    expect(block).toContain('delta-scoped');
    expect(block).toContain('No frozen findings were produced in iteration 1.');
  });

  it('falls back to still_open when prior disposition is undefined', () => {
    const block = buildPlanReviewReviewScopeBlock({
      prevFindings: [
        {
          severity: 'P2',
          citation: 'plan.md:9',
          failureScenario: 'minor',
          evidence: 'grounded',
        },
      ],
    });
    expect(block).toContain('prior disposition: still_open');
  });

  it('still emits SCOPE guidance when only recentFixCitations are set', () => {
    const block = buildPlanReviewReviewScopeBlock({
      recentFixCitations: ['plan.md:1'],
    });
    expect(block).toContain('## SCOPE');
    expect(block).toContain('## DISPOSITION GUIDANCE');
    expect(block).toContain('## RECENT FIX CITATIONS');
  });
});

describe('createPlanReviewEvidenceResolver (#716)', () => {
  it('resolves plan.md:N when the line range is within the plan artifact', async () => {
    const store = new FakeArtifactStore();
    await store.write({
      runId: 'run-x',
      relativePath: 'plan.md',
      contents: ['# Plan', 'line 2', 'line 3', 'line 4'].join('\n'),
    });
    const resolve = createPlanReviewEvidenceResolver(store, 'run-x');
    expect(
      await resolve({
        severity: 'P1',
        citation: 'plan.md:2',
        failureScenario: 'x',
        evidence: 'grounded',
      }),
    ).toBe(true);
    expect(
      await resolve({
        severity: 'P1',
        citation: 'plan.md:99',
        failureScenario: 'x',
        evidence: 'grounded',
      }),
    ).toBe(false);
  });

  it('resolves plan.md:N-M line ranges', async () => {
    const store = new FakeArtifactStore();
    await store.write({
      runId: 'run-x',
      relativePath: 'plan.md',
      contents: 'a\nb\nc\nd',
    });
    const resolve = createPlanReviewEvidenceResolver(store, 'run-x');
    expect(
      await resolve({
        severity: 'P1',
        citation: 'plan.md:2-3',
        failureScenario: 'x',
        evidence: 'grounded',
      }),
    ).toBe(true);
    expect(
      await resolve({
        severity: 'P1',
        citation: 'plan.md:3-5',
        failureScenario: 'x',
        evidence: 'grounded',
      }),
    ).toBe(false);
  });

  it('rejects reversed plan.md line ranges', async () => {
    const store = new FakeArtifactStore();
    await store.write({
      runId: 'run-x',
      relativePath: 'plan.md',
      contents: 'a\nb\nc\nd',
    });
    const resolve = createPlanReviewEvidenceResolver(store, 'run-x');
    expect(
      await resolve({
        severity: 'P1',
        citation: 'plan.md:3-2',
        failureScenario: 'x',
        evidence: 'grounded',
      }),
    ).toBe(false);
  });

  it('resolves task-manifest.json:Task N using the n field (fix to reviewer finding #3)', async () => {
    const store = new FakeArtifactStore();
    await store.write({
      runId: 'run-x',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 1,
        task_count: 3,
        tasks: [
          { n: 1, title: 'T1' },
          { n: 2, title: 'T2' },
          { n: 3, title: 'T3' },
        ],
      }),
    });
    const resolve = createPlanReviewEvidenceResolver(store, 'run-x');
    expect(
      await resolve({
        severity: 'P1',
        citation: 'task-manifest.json:Task 2',
        failureScenario: 'x',
        evidence: 'grounded',
      }),
    ).toBe(true);
    expect(
      await resolve({
        severity: 'P1',
        citation: 'task-manifest.json:Task 5',
        failureScenario: 'x',
        evidence: 'grounded',
      }),
    ).toBe(false);
  });

  it('rejects citations with missing-`n` tasks parsed via parseTaskManifest', async () => {
    const store = new FakeArtifactStore();
    await store.write({
      runId: 'run-x',
      relativePath: 'task-manifest.json',
      contents: 'version',
    });
    const resolve = createPlanReviewEvidenceResolver(store, 'run-x');
    expect(
      await resolve({
        severity: 'P1',
        citation: 'task-manifest.json:Task 1',
        failureScenario: 'x',
        evidence: 'grounded',
      }),
    ).toBe(false);
  });

  it('resolves design.md:N.M against plain headings (NO § prefix; fix to reviewer finding #4)', async () => {
    const store = new FakeArtifactStore();
    await store.write({
      runId: 'run-x',
      relativePath: 'design.md',
      contents: '# Design\n\n## 3.1 Layer summary\n\n### 7.5 Risk: #704 bonus\n',
    });
    const resolve = createPlanReviewEvidenceResolver(store, 'run-x');
    expect(
      await resolve({
        severity: 'P1',
        citation: 'design.md:3.1',
        failureScenario: 'x',
        evidence: 'grounded',
      }),
    ).toBe(true);
    expect(
      await resolve({
        severity: 'P1',
        citation: 'design.md:7.5',
        failureScenario: 'x',
        evidence: 'grounded',
      }),
    ).toBe(true);
    expect(
      await resolve({
        severity: 'P1',
        citation: 'design.md:99.0',
        failureScenario: 'x',
        evidence: 'grounded',
      }),
    ).toBe(false);
  });

  it('does NOT match §-prefixed design.md headings because design.md uses plain numbered headings', async () => {
    const store = new FakeArtifactStore();
    await store.write({
      runId: 'run-x',
      relativePath: 'design.md',
      contents: '## §3.1 Wrong form',
    });
    const resolve = createPlanReviewEvidenceResolver(store, 'run-x');
    expect(
      await resolve({
        severity: 'P1',
        citation: 'design.md:3.1',
        failureScenario: 'x',
        evidence: 'grounded',
      }),
    ).toBe(false);
  });

  it('does NOT match design.md headings that only suffix the requested section number without whitespace', async () => {
    const store = new FakeArtifactStore();
    await store.write({
      runId: 'run-x',
      relativePath: 'design.md',
      contents: '## 3.1: Wrong form',
    });
    const resolve = createPlanReviewEvidenceResolver(store, 'run-x');
    expect(
      await resolve({
        severity: 'P1',
        citation: 'design.md:3.1',
        failureScenario: 'x',
        evidence: 'grounded',
      }),
    ).toBe(false);
  });

  it('returns false when the run has no plan.md', async () => {
    const store = new FakeArtifactStore();
    const resolve = createPlanReviewEvidenceResolver(store, 'run-x');
    expect(
      await resolve({
        severity: 'P1',
        citation: 'plan.md:1',
        failureScenario: 'x',
        evidence: 'grounded',
      }),
    ).toBe(false);
  });

  it('returns false for empty citation', async () => {
    const store = new FakeArtifactStore();
    const resolve = createPlanReviewEvidenceResolver(store, 'run-x');
    expect(
      await resolve({
        severity: 'P1',
        citation: '',
        failureScenario: 'x',
        evidence: 'grounded',
      }),
    ).toBe(false);
  });
});

describe('getRecentFixCitations (#716)', () => {
  it('returns empty array when headBeforeFix is undefined', () => {
    const citations = getRecentFixCitations(process.cwd(), undefined);
    expect(citations).toEqual([]);
  });

  it('parses a unified diff hunk header into plan.md:N citations', () => {
    const fakeDiff = [
      '@@ -1,3 +1,3 @@',
      ' unchanged',
      '-old',
      '+new',
      '@@ -10,2 +12,4 @@',
      ' kept',
      '+added1',
      '+added2',
      '+added3',
    ].join('\n');
    const execSpy = vi.mocked(childProcess.execFileSync);
    const prev = execSpy.getMockImplementation();
    execSpy.mockImplementationOnce(() => fakeDiff as unknown as Buffer);
    try {
      const citations = getRecentFixCitations(process.cwd(), 'deadbeef');
      expect(citations).toContain('plan.md:1-3');
      expect(citations).toContain('plan.md:12-15');
    } finally {
      if (prev) execSpy.mockImplementation(prev);
      else execSpy.mockReset();
    }
  });
});

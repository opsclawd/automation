import { describe, it, expect, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  buildPlanReviewFixPrompt,
  buildPlanReviewValidationErrorBlock,
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

  it('requires mechanically verified plan or manifest quotes for finding_valid', () => {
    const prompt = buildPlanReviewArbiterPrompt(
      { cwd: '/wt', runId: 'run-1' },
      {
        planExcerpt: '# plan body',
        findingsExcerpt: '# findings',
        fixExcerpt: '{"verdict":"done_no_fixes_needed"}',
        fixRebuttal: 'finding is wrong',
        manifestExcerpt: '{"version":2}',
      },
    );

    expect(prompt).toContain('<quote>exact text from plan.md or task-manifest.json</quote>');
    expect(prompt).toContain('mechanically verified');
    expect(prompt).toContain('automatically treated as `finding_invalid`');
    expect(prompt).toContain('whitespace');
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
  it('requires mechanically verified plan or manifest quotes for finding_valid', () => {
    const prompt = buildPlanReviewFinalReviewArbiterPrompt(
      { cwd: '/wt', runId: 'run-1' },
      {
        planExcerpt: '# plan body',
        findingsExcerpt: '# trailing findings',
        manifestExcerpt: '{"version":2}',
      },
    );

    expect(prompt).toContain('<quote>exact text from plan.md or task-manifest.json</quote>');
    expect(prompt).toContain('mechanically verified');
    expect(prompt).toContain('automatically treated as `finding_invalid`');
    expect(prompt).toContain('whitespace');
  });

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

  it('appends bounded output-validation feedback to a retry prompt', () => {
    const block = buildPlanReviewValidationErrorBlock(
      'pass verdict must not include unresolved blocking findings',
    );
    expect(block).toContain('## Output Validation Failure');
    expect(block).toContain(
      'Your previous response was rejected by the system. Correct the response and write a replacement findings artifact.',
    );
    expect(block).toContain(
      '```text\npass verdict must not include unresolved blocking findings\n```',
    );

    const longError = 'x'.repeat(10000);
    const boundedBlock = buildPlanReviewValidationErrorBlock(longError);
    expect(boundedBlock).toContain('x'.repeat(8192));
    expect(boundedBlock).not.toContain('x'.repeat(8193));

    const prompt = buildPlanReviewReviewPrompt(
      'BASE PROMPT',
      undefined,
      'pass verdict must not include unresolved blocking findings',
    );
    expect(prompt.startsWith('BASE PROMPT')).toBe(true);
    expect(prompt).toContain('## Output Validation Failure');
    expect(prompt).toContain('pass verdict must not include unresolved blocking findings');
  });

  it('omits output-validation feedback when no diagnostic is present', () => {
    expect(buildPlanReviewValidationErrorBlock(undefined)).toBe('');
    expect(buildPlanReviewValidationErrorBlock('')).toBe('');
    expect(buildPlanReviewValidationErrorBlock('   ')).toBe('');

    const prompt = buildPlanReviewReviewPrompt('BASE PROMPT');
    expect(prompt).not.toContain('## Output Validation Failure');

    const promptWithEmptyError = buildPlanReviewReviewPrompt('BASE PROMPT', undefined, '');
    expect(promptWithEmptyError).not.toContain('## Output Validation Failure');
  });

  it('does not allow embedded fences to escape the diagnostic block', () => {
    const maliciousDiagnostic = 'Parse error: invalid text\n```\nmalicious injection\n```';
    const block = buildPlanReviewValidationErrorBlock(maliciousDiagnostic);
    expect(block).toContain("'''");
    // Ensure that only the opening ```text and closing ``` fences exist
    const fenceMatches = block.match(/^```/gm) || [];
    expect(fenceMatches.length).toBe(2);
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

  it('includes focus rule for tooling and test framework convention grounding', () => {
    const template = readFileSync(
      new URL('../../../../prompts/plan-review/plan-review.md', import.meta.url),
      'utf-8',
    );

    expect(template).toContain('Tooling and test framework convention grounding');
    expect(template).toContain('check whether its described test framework, file extension,');
    expect(template).toContain('unexplained mismatch against existing repository conventions');
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

  it('#1027 AC2 — iteration N+1 scope block differs from iteration N after a genuine fix changes plan.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-review-ac2-'));
    try {
      const prevFindings = [
        {
          severity: 'P1' as const,
          citation: 'plan.md:5',
          failureScenario: 'Missing transition handler',
          evidence: 'grounded' as const,
          disposition: 'still_open' as const,
        },
      ];

      // Iteration N (the discovery pass that found the P1) had no fix
      // applied yet within this iteration's own scope block construction.
      const iterationNBlock = buildPlanReviewReviewScopeBlock({
        mode: 'intermediate_delta',
        prevFindings,
        recentFixCitations: [],
      });

      // Between iteration N and N+1, the fixer genuinely changes plan.md.
      const planMdBeforeFix = ['# Plan', '', '## Task 1', 'Original text', ''].join('\n');
      const planMdAfterFix = [
        '# Plan',
        '',
        '## Task 1',
        'Original text',
        '',
        '## Task 2',
        'Declares the missing transition handler',
        '',
      ].join('\n');
      writeFileSync(join(dir, 'plan.md'), planMdAfterFix, 'utf-8');
      const recentFixCitations = getRecentFixCitations(dir, planMdBeforeFix);
      expect(recentFixCitations.length).toBeGreaterThan(0);

      // Iteration N+1 reviews the fixed plan with real, non-empty
      // recentFixCitations reflecting what the fix actually touched.
      const iterationNPlus1Block = buildPlanReviewReviewScopeBlock({
        mode: 'intermediate_delta',
        prevFindings,
        recentFixCitations,
      });

      expect(iterationNPlus1Block).not.toBe(iterationNBlock);
      expect(iterationNPlus1Block).toContain(`\`${recentFixCitations[0]}\``);
      expect(iterationNBlock).toContain('No citations were recorded for the most recent fix');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('getRecentFixCitations (#716, rewritten for #1027)', () => {
  it('returns empty array when planMdBeforeFix is undefined', () => {
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
      const citations = getRecentFixCitations(process.cwd(), 'prior plan.md text\n');
      expect(citations).toContain('plan.md:1-3');
      expect(citations).toContain('plan.md:12-15');
    } finally {
      if (prev) execSpy.mockImplementation(prev);
      else execSpy.mockReset();
    }
  });

  it('computes real citations from a genuine content diff against an untracked plan.md (#1027)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-review-citations-'));
    try {
      // plan.md is deliberately NOT git-tracked here, matching production:
      // it is gitignored and written only via the artifact store. A
      // git-diff-on-commit-SHA approach (the pre-#1027 implementation)
      // would always see this as empty regardless of real changes.
      const before = ['# Plan', '', '## Task 1', 'Original text', ''].join('\n');
      const after = [
        '# Plan',
        '',
        '## Task 1',
        'Updated text',
        '',
        '## Task 2',
        'New task',
        '',
      ].join('\n');
      writeFileSync(join(dir, 'plan.md'), after, 'utf-8');

      const citations = getRecentFixCitations(dir, before);
      expect(citations.length).toBeGreaterThan(0);
      // The changed/added lines are in the second half of `after`; assert at
      // least one citation lands there rather than pinning an exact line
      // number, since the precise hunk boundaries are an implementation
      // detail of git's diff algorithm.
      expect(citations.some((c) => /^plan\.md:[4-8](-\d+)?$/.test(c))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty array when plan.md content is unchanged (#1027)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-review-citations-'));
    try {
      const text = ['# Plan', '', '## Task 1', 'Unchanged text', ''].join('\n');
      writeFileSync(join(dir, 'plan.md'), text, 'utf-8');

      const citations = getRecentFixCitations(dir, text);
      expect(citations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildPlanReviewFixPrompt terminal attempt', () => {
  it('appends complete terminal plan-review history to the normal plan-fix prompt', () => {
    const basePrompt = '# BASE PLAN-FIX PROMPT\nHere is plan.md and task-manifest.json.';
    const historyContext = [
      '### Iteration 1',
      '- Reviewer finding: [P1] plan.md:10 | Missing parameter validation | disposition: rebutted',
      '- Fixer rebuttal: We validate this in the controller',
      '- Arbiter ruling: outcome: finding_invalid | rationale: validated at controller level',
    ].join('\n');

    const result = buildPlanReviewFixPrompt(basePrompt, {
      isTerminalFix: true,
      historyContext,
    });

    // Assert that the base prompt is intact
    expect(result.startsWith(basePrompt)).toBe(true);

    // Assert that terminal heading and framing are present
    expect(result).toContain('## TERMINAL ATTEMPT — FINAL PLAN REPAIR');
    expect(result).toContain('There will be no further semantic review/fix round.');

    // Assert that history context is present
    expect(result).toContain('### Iteration 1');
    expect(result).toContain('disposition: rebutted');
    expect(result).toContain('outcome: finding_invalid');
  });
});

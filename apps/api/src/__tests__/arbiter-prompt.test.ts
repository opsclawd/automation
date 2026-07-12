import { describe, it, expect } from 'vitest';
import {
  buildArbiterPrompt,
  buildImplementStepFinalReviewArbiterPrompt,
} from '../arbiter-prompt.js';

const ctx = {
  stepIndex: 4,
  stepTitle: 'Add the foo() helper',
  cwd: '/repo/worktrees/issue-657',
};

describe('buildArbiterPrompt', () => {
  it('includes Task heading, CONTEXT, INPUTS, DECISION FRAMEWORK, OUTPUT sections', () => {
    const prompt = buildArbiterPrompt(ctx, {
      tcResult: { outcome: 'fail', output: 'TS2304: foo not found' },
      disputedFinding: { fingerprint: 'fp1', severity: 'P1', summary: 'Missing error handling' },
      dispositionHistory: [],
      fixRebuttal: 'spec misread the plan letter',
      deterministicDiagnostics: 'TS2304: foo not found',
      fixDelta: 'diff --git a/foo.ts b/foo.ts',
      taskBody: '## Task 4: Add the foo() helper\n\nImplement foo() in src/foo.ts.',
    });
    expect(prompt).toContain('# TASK');
    expect(prompt).toContain('## CONTEXT');
    expect(prompt).toContain('## WORKSPACE CONSTRAINTS');
    expect(prompt).toContain('## INPUTS');
    expect(prompt).toContain('## DECISION FRAMEWORK');
    expect(prompt).toContain('## OUTPUT');
  });

  it('embeds the Task body verbatim under INPUTS', () => {
    const taskBody = '## Task 4: Add the foo() helper\n\nImplement foo() in src/foo.ts.';
    const prompt = buildArbiterPrompt(ctx, {
      tcResult: { outcome: 'pass', output: '' },
      disputedFinding: { fingerprint: 'fp1', severity: 'P0', summary: 'Test finding' },
      dispositionHistory: [],
      fixRebuttal: '',
      taskBody,
    });
    expect(prompt).toContain(taskBody);
  });

  it('marks the phase READ-ONLY and forbids code edits', () => {
    const prompt = buildArbiterPrompt(ctx, {
      tcResult: { outcome: 'pass', output: '' },
      disputedFinding: { fingerprint: 'fp1', severity: 'P2', summary: 'Test' },
      dispositionHistory: [],
      fixRebuttal: '',
      taskBody: 'stub',
    });
    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toContain('Do NOT write any code');
  });

  it('lists the four outcome enum values in DECISION FRAMEWORK', () => {
    const prompt = buildArbiterPrompt(ctx, {
      tcResult: { outcome: 'fail', output: 'TS2304' },
      disputedFinding: { fingerprint: 'fp1', severity: 'P1', summary: 'Test' },
      dispositionHistory: [],
      fixRebuttal: '',
      taskBody: 'stub',
    });
    expect(prompt).toContain('finding_valid');
    expect(prompt).toContain('finding_invalid');
    expect(prompt).toContain('ambiguous');
    expect(prompt).toContain('insufficient_evidence');
  });

  it('lists the JSON shape in the OUTPUT section', () => {
    const prompt = buildArbiterPrompt(ctx, {
      tcResult: { outcome: 'fail', output: 'TS2304' },
      disputedFinding: { fingerprint: 'fp1', severity: 'P1', summary: 'Test' },
      dispositionHistory: [],
      fixRebuttal: '',
      taskBody: 'stub',
    });
    expect(prompt).toContain('"outcome"');
    expect(prompt).toContain('"evidence"');
    expect(prompt).toContain('"rationale"');
  });

  it('embeds disputed finding when provided', () => {
    const prompt = buildArbiterPrompt(ctx, {
      tcResult: { outcome: 'fail', output: '' },
      disputedFinding: { fingerprint: 'fp1', severity: 'P0', summary: 'Critical bug' },
      dispositionHistory: [],
      fixRebuttal: '',
      taskBody: 'stub',
    });
    expect(prompt).toContain('## DISPUTED FINDING');
    expect(prompt).toContain('Critical bug');
  });

  it('embeds disposition history when provided', () => {
    const prompt = buildArbiterPrompt(ctx, {
      tcResult: { outcome: 'pass', output: '' },
      disputedFinding: { fingerprint: 'fp1', severity: 'P1', summary: 'Test' },
      dispositionHistory: [
        { fingerprint: 'fp1', disposition: 'open' },
        { fingerprint: 'fp1', disposition: 'addressed', reason: 'Fixed in commit abc' },
      ],
      fixRebuttal: '',
      taskBody: 'stub',
    });
    expect(prompt).toContain('## DISPOSITION HISTORY');
    expect(prompt).toContain('fp1');
    expect(prompt).toContain('addressed');
  });

  it('embeds deterministic diagnostics when provided', () => {
    const prompt = buildArbiterPrompt(ctx, {
      tcResult: { outcome: 'fail', output: 'TS2304: foo not found' },
      disputedFinding: { fingerprint: 'fp1', severity: 'P1', summary: 'Test' },
      dispositionHistory: [],
      fixRebuttal: '',
      deterministicDiagnostics: 'TS2304: cannot find name foo',
      taskBody: 'stub',
    });
    expect(prompt).toContain('## DETERMINISTIC DIAGNOSTICS');
    expect(prompt).toContain('TS2304: cannot find name foo');
  });

  it('embeds fix delta when provided', () => {
    const prompt = buildArbiterPrompt(ctx, {
      tcResult: { outcome: 'pass', output: '' },
      disputedFinding: { fingerprint: 'fp1', severity: 'P1', summary: 'Test' },
      dispositionHistory: [],
      fixRebuttal: '',
      fixDelta: '+ added line\n- removed line',
      taskBody: 'stub',
    });
    expect(prompt).toContain('## EXACT FIX DELTA');
    expect(prompt).toContain('+ added line');
    expect(prompt).toContain('- removed line');
  });

  it('shows message when fix delta is not available', () => {
    const prompt = buildArbiterPrompt(ctx, {
      tcResult: { outcome: 'pass', output: '' },
      disputedFinding: { fingerprint: 'fp1', severity: 'P1', summary: 'Test' },
      dispositionHistory: [],
      fixRebuttal: '',
      taskBody: 'stub',
    });
    expect(prompt).toContain('## EXACT FIX DELTA');
    expect(prompt).toContain('not available');
  });

  it('expands the typecheck section with the failure output when typecheck failed', () => {
    const prompt = buildArbiterPrompt(ctx, {
      tcResult: { outcome: 'fail', output: 'TS2304: cannot find name foo' },
      disputedFinding: { fingerprint: 'fp1', severity: 'P1', summary: 'Test' },
      dispositionHistory: [],
      fixRebuttal: '',
      taskBody: 'stub',
    });
    expect(prompt).toContain('## TYPECHECK RESULT');
    expect(prompt).toContain('Result: FAIL');
    expect(prompt).toContain('TS2304: cannot find name foo');
  });

  it('marks typecheck as PASS when typecheck succeeded', () => {
    const prompt = buildArbiterPrompt(ctx, {
      tcResult: { outcome: 'pass', output: '' },
      disputedFinding: { fingerprint: 'fp1', severity: 'P1', summary: 'Test' },
      dispositionHistory: [],
      fixRebuttal: '',
      taskBody: 'stub',
    });
    expect(prompt).toContain('Result: PASS');
    expect(prompt).not.toContain('TS2304');
  });
});

describe('buildImplementStepFinalReviewArbiterPrompt', () => {
  it('includes Task heading, CONTEXT, INPUTS, DECISION FRAMEWORK, OUTPUT sections', () => {
    const prompt = buildImplementStepFinalReviewArbiterPrompt(ctx, {
      specExcerpt: '{"result":"fail","findings":[]}',
      qualityExcerpt: '{"result":"pass"}',
      taskBody: '## Task 4: Add the foo() helper\n\nImplement foo() in src/foo.ts.',
    });
    expect(prompt).toContain('# TASK');
    expect(prompt).toContain('## CONTEXT');
    expect(prompt).toContain('## WORKSPACE CONSTRAINTS');
    expect(prompt).toContain('## INPUTS');
    expect(prompt).toContain('## DECISION FRAMEWORK');
    expect(prompt).toContain('## OUTPUT');
  });

  it('AC #6/#7 — never mentions a FixResult, done_no_fixes_needed, or rebuttal', () => {
    const prompt = buildImplementStepFinalReviewArbiterPrompt(ctx, {
      specExcerpt: '{"result":"fail"}',
      qualityExcerpt: '{"result":"pass"}',
      taskBody: '## Task 4: Add the foo() helper',
    });
    expect(prompt).not.toContain('FixResult');
    expect(prompt).not.toContain('done_no_fixes_needed');
    expect(prompt).not.toContain('rebuttal');
    expect(prompt).toContain('No fixer ran in this pass');
  });

  it('embeds the Task body verbatim under INPUTS', () => {
    const taskBody = '## Task 4: Add the foo() helper\n\nImplement foo() in src/foo.ts.';
    const prompt = buildImplementStepFinalReviewArbiterPrompt(ctx, {
      specExcerpt: '',
      qualityExcerpt: '',
      taskBody,
    });
    expect(prompt).toContain(taskBody);
  });

  it('marks the phase READ-ONLY and forbids code edits', () => {
    const prompt = buildImplementStepFinalReviewArbiterPrompt(ctx, {
      specExcerpt: '',
      qualityExcerpt: '',
      taskBody: '',
    });
    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toContain('MUST NOT modify any code');
  });
});

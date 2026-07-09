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
      specExcerpt: '{"result":"fail","findings":[]}',
      qualityExcerpt: '{"result":"fail","findings":[]}',
      fixExcerpt: '{"result":"done_no_fixes_needed","rebuttal":"spec misread"}',
      fixRebuttal: 'spec misread the plan letter',
      taskBody: '## Task 4: Add the foo() helper\n\nImplement foo() in src/foo.ts.',
    });
    expect(prompt).toContain('# TASK');
    expect(prompt).toContain('## CONTEXT');
    expect(prompt).toContain('## INPUTS');
    expect(prompt).toContain('## DECISION FRAMEWORK');
    expect(prompt).toContain('## OUTPUT');
  });

  it('embeds the Task body verbatim under INPUTS', () => {
    const taskBody = '## Task 4: Add the foo() helper\n\nImplement foo() in src/foo.ts.';
    const prompt = buildArbiterPrompt(ctx, {
      tcResult: { outcome: 'pass', output: '' },
      specExcerpt: '',
      qualityExcerpt: '',
      fixExcerpt: '',
      fixRebuttal: '',
      taskBody,
    });
    expect(prompt).toContain(taskBody);
  });

  it('marks the phase READ-ONLY and forbids code edits', () => {
    const prompt = buildArbiterPrompt(ctx, {
      tcResult: { outcome: 'pass', output: '' },
      specExcerpt: '',
      qualityExcerpt: '',
      fixExcerpt: '',
      fixRebuttal: '',
      taskBody: 'stub',
    });
    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toContain('Do NOT write any code');
  });

  it('lists the four outcome enum values in DECISION FRAMEWORK', () => {
    const prompt = buildArbiterPrompt(ctx, {
      tcResult: { outcome: 'fail', output: 'TS2304' },
      specExcerpt: '',
      qualityExcerpt: '',
      fixExcerpt: '',
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
      specExcerpt: '',
      qualityExcerpt: '',
      fixExcerpt: '',
      fixRebuttal: '',
      taskBody: 'stub',
    });
    expect(prompt).toContain('"outcome"');
    expect(prompt).toContain('"evidence"');
    expect(prompt).toContain('"rationale"');
  });

  it('embeds the spec/quality/fix excerpts when provided', () => {
    const specExcerpt = '{"result":"fail","findings":[{"severity":"P0","summary":"x"}]}';
    const qualityExcerpt = '{"result":"fail","findings":[{"severity":"P2","summary":"q"}]}';
    const fixExcerpt = '{"result":"done_no_fixes_needed","rebuttal":"y"}';
    const prompt = buildArbiterPrompt(ctx, {
      tcResult: { outcome: 'fail', output: '' },
      specExcerpt,
      qualityExcerpt,
      fixExcerpt,
      fixRebuttal: '',
      taskBody: 'stub',
    });
    expect(prompt).toContain(specExcerpt);
    expect(prompt).toContain(qualityExcerpt);
    expect(prompt).toContain(fixExcerpt);
  });

  it('embeds findings in the spec excerpt verbatim in the rendered prompt', () => {
    const findingSummary = 'Missing fix-prompt findings inlining';
    const specExcerpt = JSON.stringify({
      result: 'fail',
      findings: [{ severity: 'P1', summary: findingSummary, file: 'src/x.ts' }],
    });
    const prompt = buildArbiterPrompt(ctx, {
      tcResult: { outcome: 'pass', output: '' },
      specExcerpt,
      qualityExcerpt: '',
      fixExcerpt: '',
      fixRebuttal: '',
      taskBody: 'stub',
    });
    expect(prompt).toContain(findingSummary);
    expect(prompt).toContain('src/x.ts');
  });

  it('expands the typecheck section with the failure output when typecheck failed', () => {
    const prompt = buildArbiterPrompt(ctx, {
      tcResult: { outcome: 'fail', output: 'TS2304: cannot find name foo' },
      specExcerpt: '',
      qualityExcerpt: '',
      fixExcerpt: '',
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
      specExcerpt: '',
      qualityExcerpt: '',
      fixExcerpt: '',
      fixRebuttal: '',
      taskBody: 'stub',
    });
    expect(prompt).toContain('Result: PASS');
    expect(prompt).not.toContain('TS2304');
  });
});

describe('buildImplementStepFinalReviewArbiterPrompt (#690)', () => {
  it('includes Task heading, CONTEXT, INPUTS, DECISION FRAMEWORK, OUTPUT sections', () => {
    const prompt = buildImplementStepFinalReviewArbiterPrompt(ctx, {
      tcResult: { outcome: 'pass', output: '' },
      specExcerpt: '{"result":"fail","findings":[]}',
      qualityExcerpt: '{"result":"fail","findings":[]}',
      taskBody: '## Task 4: Add the foo() helper',
    });
    expect(prompt).toContain('# TASK');
    expect(prompt).toContain('## CONTEXT');
    expect(prompt).toContain('## INPUTS');
    expect(prompt).toContain('## DECISION FRAMEWORK');
    expect(prompt).toContain('## OUTPUT');
  });

  it('does not include a fabricated fixer narrative (#690 amendment)', () => {
    // No fixer ran on the trailing pass. The prompt MUST NOT reference
    // `done_no_fixes_needed`, `fixer`, `fixExcerpt`, or `rebuttal` —
    // including any of these would lie to the arbiter about a fixer
    // having run.
    const prompt = buildImplementStepFinalReviewArbiterPrompt(ctx, {
      tcResult: { outcome: 'pass', output: '' },
      specExcerpt: '',
      qualityExcerpt: '',
      taskBody: '## Task 4: Add the foo() helper',
    });
    expect(prompt).not.toContain('done_no_fixes_needed');
    expect(prompt).not.toContain('fixExcerpt');
    expect(prompt).not.toContain('fixer rebuttal');
    expect(prompt).not.toContain('Fixer rebuttal');
    expect(prompt).not.toContain('fix-result.json');
  });

  it('lists the four outcome enum values in DECISION FRAMEWORK', () => {
    const prompt = buildImplementStepFinalReviewArbiterPrompt(ctx, {
      tcResult: { outcome: 'fail', output: 'TS2304' },
      specExcerpt: '',
      qualityExcerpt: '',
      taskBody: 'stub',
    });
    expect(prompt).toContain('finding_valid');
    expect(prompt).toContain('finding_invalid');
    expect(prompt).toContain('ambiguous');
    expect(prompt).toContain('insufficient_evidence');
  });

  it('embeds spec/quality excerpts when provided', () => {
    const specExcerpt = '{"result":"fail","findings":[{"severity":"P0","summary":"x"}]}';
    const qualityExcerpt = '{"result":"fail","findings":[{"severity":"P2","summary":"q"}]}';
    const prompt = buildImplementStepFinalReviewArbiterPrompt(ctx, {
      tcResult: { outcome: 'pass', output: '' },
      specExcerpt,
      qualityExcerpt,
      taskBody: 'stub',
    });
    expect(prompt).toContain(specExcerpt);
    expect(prompt).toContain(qualityExcerpt);
  });

  it('marks typecheck as PASS when typecheck succeeded', () => {
    const prompt = buildImplementStepFinalReviewArbiterPrompt(ctx, {
      tcResult: { outcome: 'pass', output: '' },
      specExcerpt: '',
      qualityExcerpt: '',
      taskBody: 'stub',
    });
    expect(prompt).toContain('Result: PASS');
    expect(prompt).not.toContain('TS2304');
  });
});

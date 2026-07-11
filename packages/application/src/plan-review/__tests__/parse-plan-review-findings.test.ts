import { describe, expect, it } from 'vitest';
import {
  parsePlanReviewFindings,
  PlanReviewFindingsParseError,
} from '../parse-plan-review-findings.js';
import {
  parsePlanReviewFindings as parsePlanReviewFindingsFromRoot,
  PlanReviewFindingsParseError as PlanReviewFindingsParseErrorFromRoot,
} from '../../index.js';

function buildMarkdown(...sections: string[]): string {
  return ['# Plan Review Findings', '', ...sections].join('\n');
}

describe('parsePlanReviewFindings', () => {
  it('parses the plan-review findings markdown schema', () => {
    const markdown = buildMarkdown(
      '## verdict',
      'proceed_with_concerns',
      '',
      '## known_limitations',
      '- Keep the temporary compatibility shim',
      '',
      '## findings',
      '- [P1] `plan.md:42` | The rollback path is missing from the error handler | grounded | still_open',
      '- [P2] `docs/notes.md:8` | The wording in the recovery note is too vague | ungrounded',
      '',
    );

    expect(parsePlanReviewFindings(markdown)).toEqual({
      verdict: 'proceed_with_concerns',
      knownLimitations: ['Keep the temporary compatibility shim'],
      findings: [
        {
          severity: 'P1',
          citation: 'plan.md:42',
          failureScenario: 'The rollback path is missing from the error handler',
          evidence: 'grounded',
          disposition: 'still_open',
        },
        {
          severity: 'P2',
          citation: 'docs/notes.md:8',
          failureScenario: 'The wording in the recovery note is too vague',
          evidence: 'ungrounded',
        },
      ],
    });
  });

  it('supports multiline finding continuation text', () => {
    const markdown = buildMarkdown(
      '## verdict',
      'p1_found',
      '',
      '## findings',
      '- [P1] `plan.md:42` | The rollback path is missing',
      '  from the error handler | grounded | addressed',
      '',
    );

    expect(parsePlanReviewFindings(markdown)).toEqual({
      verdict: 'p1_found',
      findings: [
        {
          severity: 'P1',
          citation: 'plan.md:42',
          failureScenario: 'The rollback path is missing from the error handler',
          evidence: 'grounded',
          disposition: 'addressed',
        },
      ],
    });
  });

  it('allows pass verdict with all resolved findings', () => {
    const markdown = buildMarkdown(
      '## verdict',
      'pass',
      '',
      '## findings',
      '- [P1] `plan.md:28-34` | failure | grounded | addressed',
      '- [P2] `task.json:4` | failure | grounded | rebutted',
      '',
    );

    expect(parsePlanReviewFindings(markdown)).toEqual({
      verdict: 'pass',
      findings: [
        {
          severity: 'P1',
          citation: 'plan.md:28-34',
          failureScenario: 'failure',
          evidence: 'grounded',
          disposition: 'addressed',
        },
        {
          severity: 'P2',
          citation: 'task.json:4',
          failureScenario: 'failure',
          evidence: 'grounded',
          disposition: 'rebutted',
        },
      ],
    });
  });

  it.each([
    [
      'missing verdict section',
      buildMarkdown('## findings', '- [P1] `plan.md:1` | defect | grounded'),
    ],
    ['missing findings section', buildMarkdown('## verdict', 'pass')],
    [
      'invalid verdict value',
      buildMarkdown('## verdict', 'maybe', '## findings', '- [P2] `plan.md:1` | defect | grounded'),
    ],
    [
      'invalid severity token',
      buildMarkdown(
        '## verdict',
        'p1_found',
        '## findings',
        '- [P3] `plan.md:1` | defect | grounded',
      ),
    ],
    [
      'pass verdict with unresolved findings rejected',
      buildMarkdown('## verdict', 'pass', '## findings', '- [P2] `plan.md:1` | defect | grounded'),
    ],
    [
      'pass verdict with still_open findings rejected',
      buildMarkdown(
        '## verdict',
        'pass',
        '## findings',
        '- [P1] `plan.md:1` | defect | grounded | still_open',
      ),
    ],
    ['p1_found with no findings rejected', buildMarkdown('## verdict', 'p1_found', '## findings')],
    [
      'known_limitations without proceed_with_concerns rejected',
      buildMarkdown(
        '## verdict',
        'p2_only',
        '## known_limitations',
        '- keep the shim',
        '## findings',
        '- [P2] `plan.md:1` | defect | grounded',
      ),
    ],
    [
      'proceed_with_concerns without known_limitations rejected',
      buildMarkdown(
        '## verdict',
        'proceed_with_concerns',
        '## findings',
        '- [P1] `plan.md:1` | defect | grounded',
      ),
    ],
    [
      'empty known_limitations bullets rejected',
      buildMarkdown(
        '## verdict',
        'proceed_with_concerns',
        '## known_limitations',
        '',
        '## findings',
        '- [P1] `plan.md:1` | defect | grounded',
      ),
    ],
  ])('throws PlanReviewFindingsParseError for %s', (_label, markdown) => {
    expect(() => parsePlanReviewFindings(markdown)).toThrow(PlanReviewFindingsParseError);
  });

  it('is re-exported from the application barrel', () => {
    expect(parsePlanReviewFindingsFromRoot).toBe(parsePlanReviewFindings);
    expect(PlanReviewFindingsParseErrorFromRoot).toBe(PlanReviewFindingsParseError);
  });
});

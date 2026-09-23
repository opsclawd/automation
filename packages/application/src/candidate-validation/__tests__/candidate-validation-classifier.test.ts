import { describe, expect, it } from 'vitest';
import {
  isRecognizedCandidatePath,
  classifyCandidateContent,
  findDuplicateJsonKeys,
} from '../candidate-validation-classifier.js';

describe('isRecognizedCandidatePath()', () => {
  it('recognizes candidate validation reports in docs/ or root', () => {
    expect(isRecognizedCandidatePath('docs/phase-3-candidate-validation-report.md')).toBe(
      'candidate_validation_report',
    );
    expect(isRecognizedCandidatePath('candidate_validation_report.md')).toBe(
      'candidate_validation_report',
    );
    expect(isRecognizedCandidatePath('docs/phase-1-candidate_validation_report.md')).toBe(
      'candidate_validation_report',
    );
  });

  it('recognizes audit closeout JSON files in docs/ or root', () => {
    expect(isRecognizedCandidatePath('docs/phase-3-audit-closeout.json')).toBe('audit_closeout');
    expect(isRecognizedCandidatePath('audit_closeout.json')).toBe('audit_closeout');
    expect(isRecognizedCandidatePath('docs/audit-closeout.json')).toBe('audit_closeout');
  });

  it('excludes template files even if matching candidate patterns', () => {
    expect(isRecognizedCandidatePath('docs/phase-3-report-template.md')).toBeNull();
    expect(
      isRecognizedCandidatePath('docs/phase-3-candidate-validation-report-template.md'),
    ).toBeNull();
    expect(isRecognizedCandidatePath('candidate-validation-report-template.md')).toBeNull();
    expect(isRecognizedCandidatePath('docs/audit-closeout-template.json')).toBeNull();
  });

  it('excludes general repository documentation', () => {
    expect(isRecognizedCandidatePath('README.md')).toBeNull();
    expect(isRecognizedCandidatePath('CONTEXT.md')).toBeNull();
    expect(isRecognizedCandidatePath('AGENTS.md')).toBeNull();
    expect(isRecognizedCandidatePath('docs/design-decisions-report.md')).toBeNull();
    expect(isRecognizedCandidatePath('docs/architecture-review.md')).toBeNull();
    expect(isRecognizedCandidatePath('finding-ledger.json')).toBeNull();
  });
});

describe('classifyCandidateContent() - Markdown reports', () => {
  it('detects incident witness report with checked [x] GO and human sign-off line', () => {
    const content = `
# Phase 3 Candidate Validation Report

## Disposition
- [x] GO
- [ ] NO-GO

Reviewing Authority (Sign-off): opsclawd (operator)
Date: 2026-09-19
`;
    const findings = classifyCandidateContent(
      'docs/phase-3-candidate-validation-report.md',
      content,
      'candidate_validation_report',
    );

    expect(findings.some((f) => f.code === 'AFFIRMATIVE_DISPOSITION')).toBe(true);
    expect(findings.some((f) => f.code === 'HUMAN_SIGN_OFF')).toBe(true);
  });

  it('detects human sign-off alone with balanced parentheses qualifier (Witness-1)', () => {
    const content = `
# Phase 3 Candidate Validation Report

Candidate SHA: <pinned-candidate-sha>
Reviewing Authority (Sign-off): opsclawd (operator)

- [ ] GO
- [ ] NO-GO
`;
    const findings = classifyCandidateContent(
      'docs/phase-3-candidate-validation-report.md',
      content,
      'candidate_validation_report',
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('HUMAN_SIGN_OFF');
    expect(findings[0]?.message).toContain('opsclawd (operator)');
  });

  it('detects measured scenario claims, quantitative metrics, and real provider execution (Witness-4)', () => {
    const content = `
# Phase 3 Candidate Validation Report

Candidate SHA: <pinned-candidate-sha>
Scenarios Passed: 3/3
Requirement Coverage: 100%
Story Readiness: 100%
Historical Immutability: 100%
Real-Provider Execution: Completed

- [ ] GO
- [ ] NO-GO
`;
    const findings = classifyCandidateContent(
      'docs/phase-3-candidate-validation-report.md',
      content,
      'candidate_validation_report',
    );

    const codes = findings.map((f) => f.code);
    expect(codes).toContain('MEASURED_SCENARIO_CLAIM');
    expect(codes).toContain('MEASURED_METRIC_CLAIM');
    expect(codes).toContain('REAL_PROVIDER_CLAIM');
    expect(codes).not.toContain('AFFIRMATIVE_DISPOSITION');
    expect(codes).not.toContain('HUMAN_SIGN_OFF');
  });

  it('detects concrete 40-hex candidate SHA binding', () => {
    const content = `
# Candidate Validation Report
Candidate SHA: f3e79a24c18b76df429810a019485bb396e69001
- [ ] GO
`;
    const findings = classifyCandidateContent(
      'docs/candidate-validation-report.md',
      content,
      'candidate_validation_report',
    );

    expect(findings.some((f) => f.code === 'CANDIDATE_SHA_BINDING')).toBe(true);
  });

  it('allows blank templates with placeholders and unchecked boxes', () => {
    const content = `
# Phase 3 Candidate Validation Report Template

Candidate SHA: <pinned-candidate-sha>
Reviewing Authority (Sign-off): <operator-name>
Date: <date>

Scenarios Passed: <passed>/<total>
Requirement Coverage: <percentage>
Real-Provider Execution: <pending>

- [ ] GO
- [ ] NO-GO

Disposition: PENDING
`;
    const findings = classifyCandidateContent(
      'docs/phase-3-candidate-validation-report.md',
      content,
      'candidate_validation_report',
    );

    expect(findings).toHaveLength(0);
  });

  it('ignores structural examples inside fenced code blocks', () => {
    const content = `
# Template Guide

Here is an example of what a filled report looks like:

\`\`\`markdown
- [x] GO
Reviewing Authority (Sign-off): opsclawd (operator)
\`\`\`

- [ ] GO
- [ ] NO-GO
Reviewing Authority (Sign-off): <operator-name>
`;
    const findings = classifyCandidateContent(
      'docs/phase-3-candidate-validation-report.md',
      content,
      'candidate_validation_report',
    );

    expect(findings).toHaveLength(0);
  });
});

describe('classifyCandidateContent() - Audit Closeout JSON', () => {
  it('detects incident witness audit closeout JSON', () => {
    const content = JSON.stringify({
      promotionDecision: {
        candidateSha: 'f3e79a24c18b76df429810a019485bb396e69001',
        decision: 'GO',
      },
      scenariosPassed: '3/3',
      metrics: {
        requirementCoverage: '100%',
        storyReadiness: '100%',
        syntaxCompliance: '100%',
        historicalImmutability: '100%',
      },
      realProviderValidation: true,
      signOff: 'opsclawd (operator)',
    });

    const findings = classifyCandidateContent(
      'docs/phase-3-audit-closeout.json',
      content,
      'audit_closeout',
    );

    const codes = findings.map((f) => f.code);
    expect(codes).toContain('AFFIRMATIVE_DISPOSITION');
    expect(codes).toContain('CANDIDATE_SHA_BINDING');
    expect(codes).toContain('HUMAN_SIGN_OFF');
    expect(codes).toContain('MEASURED_SCENARIO_CLAIM');
    expect(codes).toContain('MEASURED_METRIC_CLAIM');
    expect(codes).toContain('REAL_PROVIDER_CLAIM');
  });

  it('allows blank JSON templates with null and placeholder fields', () => {
    const content = JSON.stringify({
      promotionDecision: {
        candidateSha: '<candidate-sha>',
        decision: null,
      },
      scenariosPassed: '0/0',
      metrics: {
        requirementCoverage: null,
        storyReadiness: 'TODO',
      },
      realProviderValidation: false,
      signOff: null,
    });

    const findings = classifyCandidateContent(
      'docs/phase-3-audit-closeout.json',
      content,
      'audit_closeout',
    );

    expect(findings).toHaveLength(0);
  });

  it('detects duplicate JSON keys to prevent semantic parser evasion', () => {
    const rawJson = `{\n  "decision": "<pending>",\n  "decision": "GO"\n}`;
    const findings = classifyCandidateContent(
      'docs/phase-3-audit-closeout.json',
      rawJson,
      'audit_closeout',
    );

    expect(findings.some((f) => f.code === 'DUPLICATE_JSON_KEY')).toBe(true);
    expect(findings.some((f) => f.code === 'AFFIRMATIVE_DISPOSITION')).toBe(true);
  });
});

describe('findDuplicateJsonKeys()', () => {
  it('finds duplicate keys in object', () => {
    const json = '{"a": 1, "b": 2, "a": 3}';
    expect(findDuplicateJsonKeys(json)).toEqual(['a']);
  });

  it('returns empty for distinct keys in nested objects', () => {
    const json = '{"a": {"a": 1}}';
    expect(findDuplicateJsonKeys(json)).toEqual([]);
  });

  it('handles strings with escaped quotes', () => {
    const json = '{"key\\"with\\"quote": 1, "normal": 2}';
    expect(findDuplicateJsonKeys(json)).toEqual([]);
  });
});

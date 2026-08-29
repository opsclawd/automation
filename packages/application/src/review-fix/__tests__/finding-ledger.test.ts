import { describe, it, expect } from 'vitest';
import {
  createFindingLedger,
  updateFindingLedger,
  computeFindingFingerprint,
  hasUnresolvedBlockingFindings,
  formatLedgerForPrompt,
  formatLedgerForFixPrompt,
} from '../finding-ledger.js';

describe('finding-ledger', () => {
  it('creates ledger with stable fingerprints from initial review findings', () => {
    const findings = [
      {
        severity: 'high' as const,
        files: ['packages/app.ts'],
        evidence: 'missing error handling',
        rationale: 'unhandled exception on invalid input',
        minimal_correction: 'wrap in try/catch',
      },
      {
        severity: 'medium' as const,
        files: ['packages/util.ts'],
        evidence: 'typo in docstring',
        rationale: 'minor comment typo',
        minimal_correction: 'fix typo',
      },
    ];

    const acs = [
      {
        criterion: 'AC 1: Must handle invalid input',
        result: 'FAIL' as const,
        evidence: 'throws unhandled error',
      },
      {
        criterion: 'AC 2: Must export function',
        result: 'PASS' as const,
      },
    ];

    const ledger = createFindingLedger(findings, acs);

    expect(ledger.version).toBe(1);
    expect(ledger.iterationCount).toBe(0);
    expect(ledger.entries.length).toBe(3); // 1 failed AC + 2 findings

    // Failed AC entry
    expect(ledger.entries[0]!.id).toBe('AC-1');
    expect(ledger.entries[0]!.status).toBe('unresolved');
    expect(ledger.entries[0]!.isAcceptanceCriterionFailure).toBe(true);

    // Finding entries
    expect(ledger.entries[1]!.status).toBe('unresolved');
    expect(ledger.entries[1]!.files).toEqual(['packages/app.ts']);
    expect(ledger.entries[2]!.status).toBe('unresolved');

    expect(hasUnresolvedBlockingFindings(ledger)).toBe(true);
  });

  it('updates finding ledger on follow-up review', () => {
    const findings = [
      {
        severity: 'high' as const,
        files: ['packages/app.ts'],
        evidence: 'missing error handling',
        rationale: 'unhandled exception',
        minimal_correction: 'add try/catch',
      },
      {
        severity: 'high' as const,
        files: ['packages/db.ts'],
        evidence: 'leak in db connection',
        rationale: 'connection not closed',
        minimal_correction: 'close connection',
      },
    ];

    const ledger = createFindingLedger(findings);
    const f1Id = ledger.entries[0]!.id;
    const f2Id = ledger.entries[1]!.id;

    // Follow-up resolves F1, leaves F2 open, and adds new finding F3
    const evaluations = [
      {
        finding_id: f1Id,
        resolved: true,
        evidence: 'try/catch added in app.ts',
      },
      {
        finding_id: f2Id,
        resolved: false,
        evidence: 'connection still open in db.ts:42',
      },
    ];

    const newFindings = [
      {
        severity: 'medium' as const,
        files: ['packages/app.ts'],
        evidence: 'catch block swallows error silently',
        rationale: 'should log caught error',
        minimal_correction: 'add logger.error',
      },
    ];

    const updated = updateFindingLedger(ledger, evaluations, newFindings, 1);

    expect(updated.iterationCount).toBe(1);
    expect(updated.entries.length).toBe(3);

    const f1 = updated.entries.find((e) => e.id === f1Id)!;
    expect(f1.status).toBe('resolved');
    expect(f1.resolvedInIteration).toBe(1);
    expect(f1.resolutionEvidence).toBe('try/catch added in app.ts');

    const f2 = updated.entries.find((e) => e.id === f2Id)!;
    expect(f2.status).toBe('unresolved');

    const f3 = updated.entries.find((e) => e.id !== f1Id && e.id !== f2Id)!;
    expect(f3.status).toBe('unresolved');
    expect(f3.sourceIteration).toBe(1);

    expect(hasUnresolvedBlockingFindings(updated)).toBe(true);
  });

  it('detects when all findings are resolved', () => {
    const findings = [
      {
        severity: 'high' as const,
        files: ['packages/app.ts'],
        evidence: 'bug',
        rationale: 'bug rationale',
        minimal_correction: 'fix bug',
      },
    ];
    const ledger = createFindingLedger(findings);
    const id = ledger.entries[0]!.id;

    const updated = updateFindingLedger(
      ledger,
      [{ finding_id: id, resolved: true, evidence: 'fixed' }],
      [],
      1,
    );

    expect(hasUnresolvedBlockingFindings(updated)).toBe(false);
  });

  it('formats ledger for reviewer prompt and fixer prompt', () => {
    const findings = [
      {
        severity: 'high' as const,
        files: ['src/core.ts'],
        evidence: 'null pointer dereference',
        rationale: 'user object may be undefined',
        minimal_correction: 'add optional chaining',
      },
    ];
    const ledger = createFindingLedger(findings);
    const promptText = formatLedgerForPrompt(ledger);
    const fixPromptText = formatLedgerForFixPrompt(ledger);

    expect(promptText).toContain('UNRESOLVED BLOCKING FINDINGS');
    expect(promptText).toContain('user object may be undefined');
    expect(promptText).toContain('src/core.ts');

    expect(fixPromptText).toContain('FINDINGS TO RESOLVE');
    expect(fixPromptText).toContain('add optional chaining');
  });

  it('generates consistent hash fingerprints', () => {
    const f1 = {
      files: ['a.ts', 'b.ts'],
      severity: 'high',
      rationale: 'missing check',
      minimal_correction: 'add check',
    };
    const f2 = {
      files: ['b.ts', 'a.ts'],
      severity: 'high',
      rationale: 'missing check',
      minimal_correction: 'add check',
    };

    const fp1 = computeFindingFingerprint(f1);
    const fp2 = computeFindingFingerprint(f2);
    expect(fp1).toBe(fp2);
    expect(fp1.startsWith('F-')).toBe(true);
  });
});

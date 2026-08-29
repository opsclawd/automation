import { createHash } from 'node:crypto';
import type {
  WholeChangeReviewFinding,
  AcceptanceCriterionCheck,
} from '../results/schemas/whole-change-review.js';
import type { FollowUpFindingEvaluation } from '../results/schemas/follow-up-review.js';

export interface FindingLedgerEntry {
  id: string;
  status: 'unresolved' | 'resolved';
  severity: string;
  files: string[];
  evidence: string;
  rationale: string;
  minimal_correction: string;
  sourceIteration: number;
  resolvedInIteration?: number;
  resolutionEvidence?: string;
  isAcceptanceCriterionFailure?: boolean;
}

export interface FindingLedger {
  version: 1;
  iterationCount: number;
  entries: FindingLedgerEntry[];
}

export function computeFindingFingerprint(
  finding: {
    files?: string[];
    severity?: string;
    rationale?: string;
    minimal_correction?: string;
    evidence?: string;
  },
  fallbackIndex = 0,
): string {
  const normFiles = (finding.files ?? []).slice().sort().join(',');
  const normRationale = (finding.rationale ?? '').trim().toLowerCase();
  const normCorrection = (finding.minimal_correction ?? '').trim().toLowerCase();
  const normEvidence = (finding.evidence ?? '').trim().toLowerCase().slice(0, 100);

  const raw = `${normFiles}|${normRationale}|${normCorrection}|${normEvidence}`;
  if (raw.length > 3) {
    const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8);
    return `F-${hash}`;
  }
  return `F-${fallbackIndex + 1}`;
}

export function createFindingLedger(
  findings: WholeChangeReviewFinding[],
  acceptanceCriteria: AcceptanceCriterionCheck[] = [],
): FindingLedger {
  const entries: FindingLedgerEntry[] = [];
  const seenIds = new Set<string>();

  // Add failed acceptance criteria as high-priority findings
  const failingACs = acceptanceCriteria.filter((ac) => ac.result?.toUpperCase() === 'FAIL');
  for (let i = 0; i < failingACs.length; i++) {
    const ac = failingACs[i]!;
    let id = `AC-${i + 1}`;
    let suffix = 1;
    while (seenIds.has(id)) {
      id = `AC-${i + 1}-${suffix++}`;
    }
    seenIds.add(id);

    entries.push({
      id,
      status: 'unresolved',
      severity: 'high',
      files: [],
      evidence: ac.evidence || 'Acceptance criterion not satisfied',
      rationale: `Failed acceptance criterion: ${ac.criterion}`,
      minimal_correction: `Implement requirement to satisfy: ${ac.criterion}`,
      sourceIteration: 0,
      isAcceptanceCriterionFailure: true,
    });
  }

  // Add review findings
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i]!;
    let id = computeFindingFingerprint(f, i);
    let suffix = 1;
    while (seenIds.has(id)) {
      id = `${computeFindingFingerprint(f, i)}-${suffix++}`;
    }
    seenIds.add(id);

    entries.push({
      id,
      status: 'unresolved',
      severity: f.severity || 'high',
      files: f.files || [],
      evidence: f.evidence || '',
      rationale: f.rationale || '',
      minimal_correction: f.minimal_correction || '',
      sourceIteration: 0,
      isAcceptanceCriterionFailure: false,
    });
  }

  return {
    version: 1,
    iterationCount: 0,
    entries,
  };
}

export function updateFindingLedger(
  ledger: FindingLedger,
  evaluations: FollowUpFindingEvaluation[],
  newFindings: WholeChangeReviewFinding[] = [],
  iterationIndex: number,
): FindingLedger {
  const evalMap = new Map<string, FollowUpFindingEvaluation>();
  for (const ev of evaluations) {
    evalMap.set(ev.finding_id, ev);
  }

  const existingIds = new Set(ledger.entries.map((e) => e.id));

  // Update existing entries
  const updatedEntries: FindingLedgerEntry[] = ledger.entries.map((entry) => {
    const ev = evalMap.get(entry.id);
    if (ev) {
      if (ev.resolved) {
        return {
          ...entry,
          status: 'resolved',
          resolvedInIteration: iterationIndex,
          resolutionEvidence: ev.evidence,
        };
      }
      return {
        ...entry,
        status: 'unresolved',
      };
    }
    return entry;
  });

  // Append new findings
  for (let i = 0; i < newFindings.length; i++) {
    const nf = newFindings[i]!;
    let id = computeFindingFingerprint(nf, ledger.entries.length + i);
    let suffix = 1;
    while (existingIds.has(id)) {
      id = `${computeFindingFingerprint(nf, ledger.entries.length + i)}-${suffix++}`;
    }
    existingIds.add(id);

    updatedEntries.push({
      id,
      status: 'unresolved',
      severity: nf.severity || 'high',
      files: nf.files || [],
      evidence: nf.evidence || '',
      rationale: nf.rationale || '',
      minimal_correction: nf.minimal_correction || '',
      sourceIteration: iterationIndex,
      isAcceptanceCriterionFailure: false,
    });
  }

  return {
    version: 1,
    iterationCount: iterationIndex,
    entries: updatedEntries,
  };
}

export function hasUnresolvedBlockingFindings(ledger: FindingLedger): boolean {
  return ledger.entries.some((e) => e.status === 'unresolved');
}

export function formatLedgerForPrompt(ledger: FindingLedger): string {
  if (ledger.entries.length === 0) {
    return 'No review findings recorded.';
  }

  const lines: string[] = [];
  const unresolved = ledger.entries.filter((e) => e.status === 'unresolved');
  const resolved = ledger.entries.filter((e) => e.status === 'resolved');

  if (unresolved.length > 0) {
    lines.push('### UNRESOLVED BLOCKING FINDINGS:');
    for (const f of unresolved) {
      lines.push(`- **[${f.id}] [${f.severity.toUpperCase()}]** ${f.rationale}`);
      if (f.files.length > 0) {
        lines.push(`  Files: ${f.files.join(', ')}`);
      }
      lines.push(`  Evidence: ${f.evidence}`);
      lines.push(`  Required Fix: ${f.minimal_correction}`);
      lines.push(`  Source: iteration ${f.sourceIteration}`);
      lines.push('');
    }
  }

  if (resolved.length > 0) {
    lines.push('### PREVIOUSLY RESOLVED FINDINGS (REGRESSION CHECKLIST):');
    for (const f of resolved) {
      lines.push(
        `- **[${f.id}] [RESOLVED in iter ${f.resolvedInIteration ?? '?'}]** ${f.rationale}`,
      );
      if (f.resolutionEvidence) {
        lines.push(`  Resolution Evidence: ${f.resolutionEvidence}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function formatLedgerForFixPrompt(ledger: FindingLedger): string {
  const unresolved = ledger.entries.filter((e) => e.status === 'unresolved');
  if (unresolved.length === 0) {
    return 'No unresolved findings.';
  }

  const lines: string[] = ['### FINDINGS TO RESOLVE:'];
  for (const f of unresolved) {
    lines.push(`- **[${f.id}] [${f.severity.toUpperCase()}]** ${f.rationale}`);
    if (f.files.length > 0) {
      lines.push(`  Files: ${f.files.join(', ')}`);
    }
    lines.push(`  Evidence: ${f.evidence}`);
    lines.push(`  Required Fix: ${f.minimal_correction}`);
    lines.push('');
  }
  return lines.join('\n');
}

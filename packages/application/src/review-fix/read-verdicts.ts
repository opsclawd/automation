import type { AgentInvocation } from '@ai-sdlc/domain';
import { extractResult, type ExtractResultOutcome } from '../results/extract-result.js';
import { PHASE_RESULT_REGISTRY } from '../results/phase-registry.js';
import type { ArtifactStore, StructuredResultRepairPort } from '../ports.js';
import type { WholePrReviewResult } from '../results/schemas/whole-pr-review.js';
import type {
  WholeChangeReviewResult,
  WholeChangeReviewFinding,
  AcceptanceCriterionCheck,
} from '../results/schemas/whole-change-review.js';
import type {
  NarrowVerificationResult,
  FindingEvaluation,
} from '../results/schemas/narrow-verification.js';
import type { FixReviewResult } from '../results/schemas/fix-review.js';

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
};

function severityRank(severity: string): number | undefined {
  return SEVERITY_RANK[severity.trim().toLowerCase()];
}

export function severityGate(
  findings: WholePrReviewResult['findings'],
  threshold: string,
): { blocked: boolean; offendingFindings: WholePrReviewResult['findings'] } {
  const thresholdRank = severityRank(threshold) ?? SEVERITY_RANK['medium']!;
  const offending = findings.filter((f) => (severityRank(f.severity) ?? Infinity) <= thresholdRank);
  return { blocked: offending.length > 0, offendingFindings: offending };
}

function allKnownSeveritiesBelowThreshold(
  findings: WholePrReviewResult['findings'],
  threshold: string,
): boolean {
  if (findings.length === 0) return false;
  const thresholdRank = severityRank(threshold) ?? SEVERITY_RANK['medium']!;
  return findings.every((f) => {
    const rank = severityRank(f.severity);
    if (rank === undefined) return false;
    return rank > thresholdRank;
  });
}

type ExtractResultFailure = Extract<ExtractResultOutcome, { ok: false }>;

export type VerdictOutcome<V> =
  | {
      ok: true;
      verdict: V;
      overridden?: boolean;
      offendingFindings?: Array<{ severity: string; summary: string; files?: string[] }>;
      rebuttal?: string;
      outOfScopeReasons?: Record<string, string>;
    }
  | {
      ok: false;
      detail: string;
      classification: ExtractResultFailure['classification'];
      violationCode: ExtractResultFailure['violationCode'];
    };

export interface ReadReviewVerdictOptions {
  blockOnSeverity?: string;
  cwd?: string;
  transcriptEvidence?: string;
  issueBodyPresent?: boolean;
}

export function readReviewVerdict(
  invocation: AgentInvocation,
  ports: { artifacts: ArtifactStore; repair?: StructuredResultRepairPort; agent?: unknown },
  opts: ReadReviewVerdictOptions & { allowFabricated: true },
): Promise<VerdictOutcome<'pass' | 'fail' | 'fabricated'>>;
export function readReviewVerdict(
  invocation: AgentInvocation,
  ports: { artifacts: ArtifactStore; repair?: StructuredResultRepairPort; agent?: unknown },
  opts?: ReadReviewVerdictOptions & { allowFabricated?: false },
): Promise<VerdictOutcome<'pass' | 'fail'>>;
export async function readReviewVerdict(
  invocation: AgentInvocation,
  ports: { artifacts: ArtifactStore; repair?: StructuredResultRepairPort; agent?: unknown },
  opts?: ReadReviewVerdictOptions & { allowFabricated?: boolean },
): Promise<VerdictOutcome<'pass' | 'fail' | 'fabricated'>> {
  const r = await extractResult({
    invocation,
    ports,
    cwd: opts?.cwd,
    transcriptEvidence: opts?.transcriptEvidence,
  });
  if (!r.ok) {
    return {
      ok: false,
      detail: r.detail,
      classification: r.classification,
      violationCode: r.violationCode,
    };
  }
  const raw = r.result as {
    result?: 'pass' | 'fail' | 'fabricated';
    findings?: Array<{
      severity: string;
      summary: string;
      file?: string;
      suggested_fix?: string;
      files?: string[];
    }>;
  };

  if (raw.result === 'fabricated') {
    if (opts?.allowFabricated) {
      return {
        ok: true,
        verdict: 'fabricated',
        ...(raw.findings && raw.findings.length > 0 ? { offendingFindings: raw.findings } : {}),
      };
    }
    return {
      ok: true,
      verdict: 'fail',
      offendingFindings:
        raw.findings && raw.findings.length > 0
          ? raw.findings
          : [{ severity: 'critical', summary: 'Fabricated evidence detected' }],
    };
  }

  if (
    opts?.issueBodyPresent &&
    raw.result === 'pass' &&
    (!raw.findings || raw.findings.length === 0)
  ) {
    return {
      ok: true,
      verdict: 'fail',
      offendingFindings: [
        {
          severity: 'critical',
          summary:
            'Empty-pass verdict when issue.md is present — anchored-design review requires explicit findings citing issue.md:N',
        },
      ],
    };
  }

  if (opts?.blockOnSeverity && raw.findings && raw.findings.length > 0) {
    const normalizedFindings: WholePrReviewResult['findings'] = raw.findings.map((f) => ({
      severity: f.severity,
      summary: f.summary,
      files: f.files ?? (f.file ? [f.file] : []),
    }));
    const { blocked, offendingFindings } = severityGate(normalizedFindings, opts.blockOnSeverity);

    if (blocked) {
      if (raw.result === 'pass') {
        return {
          ok: true,
          verdict: 'fail',
          overridden: true,
          offendingFindings,
        };
      }
      return { ok: true, verdict: 'fail', offendingFindings };
    }

    const allBelow = allKnownSeveritiesBelowThreshold(normalizedFindings, opts.blockOnSeverity);

    if (allBelow && raw.result === 'fail') {
      return {
        ok: true,
        verdict: 'pass',
        overridden: true,
        offendingFindings: [],
      };
    }
  }

  if (raw.result === 'fail' && raw.findings && raw.findings.length > 0) {
    return { ok: true, verdict: 'fail', offendingFindings: raw.findings };
  }

  return { ok: true, verdict: raw.result ?? 'pass' };
}

export async function readFixVerdict(
  invocation: AgentInvocation,
  ports: { artifacts: ArtifactStore; repair?: StructuredResultRepairPort; agent?: unknown },
  opts?: { cwd?: string; repairExpectedHead?: string; transcriptEvidence?: string },
): Promise<VerdictOutcome<FixReviewResult['result']>> {
  const r = await extractResult({
    invocation,
    ports,
    cwd: opts?.cwd,
    repairExpectedHead: opts?.repairExpectedHead,
    transcriptEvidence: opts?.transcriptEvidence,
  });
  if (!r.ok) {
    return {
      ok: false,
      detail: r.detail,
      classification: r.classification,
      violationCode: r.violationCode,
    };
  }
  const fixResult = r.result as FixReviewResult;
  return {
    ok: true,
    verdict: fixResult.result,
    ...(fixResult.out_of_scope_reasons && Object.keys(fixResult.out_of_scope_reasons).length > 0
      ? { outOfScopeReasons: fixResult.out_of_scope_reasons }
      : {}),
    ...(fixResult.result === 'done_no_fixes_needed' ? { rebuttal: fixResult.rebuttal } : {}),
  };
}

export interface ReadWholeChangeReviewVerdictOptions {
  cwd?: string;
  transcriptEvidence?: string;
  issueBodyPresent?: boolean;
}

export type WholeChangeVerdictOutcome =
  | {
      ok: true;
      verdict: 'APPROVE' | 'REQUEST_CHANGES';
      acceptanceCriteria: AcceptanceCriterionCheck[];
      findings: WholeChangeReviewFinding[];
      summary?: string;
      overridden?: boolean;
      overrideReason?: string;
    }
  | {
      ok: false;
      detail: string;
      classification: ExtractResultFailure['classification'];
      violationCode: ExtractResultFailure['violationCode'];
    };

export type EvaluatedWholeChangeVerdict = Extract<WholeChangeVerdictOutcome, { ok: true }>;

export function evaluateWholeChangeReviewVerdict(
  raw: WholeChangeReviewResult,
  opts?: { issueBodyPresent?: boolean },
): EvaluatedWholeChangeVerdict {
  const normalizedVerdict =
    raw.verdict?.toUpperCase() === 'APPROVE' ? 'APPROVE' : 'REQUEST_CHANGES';
  const acceptanceCriteria = raw.acceptance_criteria ?? [];
  const findings = raw.findings ?? [];
  const summary = raw.summary;

  // Anti-trap 1: Empty acceptance criteria protection when issue.md is present
  if (opts?.issueBodyPresent && acceptanceCriteria.length === 0) {
    return {
      ok: true,
      verdict: 'REQUEST_CHANGES',
      overridden: true,
      overrideReason:
        'Empty acceptance criteria verification — whole-change review requires explicit evaluation of acceptance criteria',
      acceptanceCriteria,
      findings: [
        {
          severity: 'critical',
          files: [],
          evidence: 'No acceptance criteria evaluated in result.json',
          rationale: 'Reviewer failed to evaluate acceptance criteria from issue.md',
          minimal_correction:
            'Enumerate each acceptance criterion from issue.md and evaluate PASS/FAIL',
          blocking: true,
        },
        ...findings,
      ],
      ...(summary !== undefined ? { summary } : {}),
    };
  }

  // Anti-trap 2: Any failing acceptance criteria MUST force REQUEST_CHANGES
  const failingCriteria = acceptanceCriteria.filter((c) => c.result?.toUpperCase() === 'FAIL');
  if (failingCriteria.length > 0 && normalizedVerdict === 'APPROVE') {
    return {
      ok: true,
      verdict: 'REQUEST_CHANGES',
      overridden: true,
      overrideReason: `Acceptance criteria failed: ${failingCriteria.map((c) => c.criterion).join(', ')}`,
      acceptanceCriteria,
      findings,
      ...(summary !== undefined ? { summary } : {}),
    };
  }

  // Anti-trap 3: Severity gating — critical/high findings force REQUEST_CHANGES
  const blockingFindings = findings.filter(
    (f) =>
      f.blocking === true ||
      f.severity?.toLowerCase() === 'critical' ||
      f.severity?.toLowerCase() === 'high' ||
      f.severity?.toUpperCase() === 'P0' ||
      f.severity?.toUpperCase() === 'P1',
  );

  if (blockingFindings.length > 0 && normalizedVerdict === 'APPROVE') {
    return {
      ok: true,
      verdict: 'REQUEST_CHANGES',
      overridden: true,
      overrideReason: `Blocking findings present (${blockingFindings.length} critical/high findings)`,
      acceptanceCriteria,
      findings,
      ...(summary !== undefined ? { summary } : {}),
    };
  }

  // If there are failing criteria or blocking findings, verdict is REQUEST_CHANGES
  if (failingCriteria.length > 0 || blockingFindings.length > 0) {
    return {
      ok: true,
      verdict: 'REQUEST_CHANGES',
      acceptanceCriteria,
      findings,
      ...(summary !== undefined ? { summary } : {}),
    };
  }

  return {
    ok: true,
    verdict: normalizedVerdict,
    acceptanceCriteria,
    findings,
    ...(summary !== undefined ? { summary } : {}),
  };
}

export async function readWholeChangeReviewVerdict(
  invocation: AgentInvocation,
  ports: { artifacts: ArtifactStore; repair?: StructuredResultRepairPort; agent?: unknown },
  opts?: ReadWholeChangeReviewVerdictOptions,
): Promise<WholeChangeVerdictOutcome> {
  const r = await extractResult({
    invocation,
    ports,
    cwd: opts?.cwd,
    transcriptEvidence: opts?.transcriptEvidence,
    resultMeta: PHASE_RESULT_REGISTRY['whole-change-review'],
  });
  if (!r.ok) {
    return {
      ok: false,
      detail: r.detail,
      classification: r.classification,
      violationCode: r.violationCode,
    };
  }

  return evaluateWholeChangeReviewVerdict(r.result, opts);
}

export interface ReadNarrowVerificationVerdictOptions {
  cwd?: string;
  transcriptEvidence?: string;
  originalFindingsCount?: number;
}

export type NarrowVerificationVerdictOutcome =
  | {
      ok: true;
      verdict: 'PASS' | 'FAIL';
      evaluations: FindingEvaluation[];
      regressions: string[];
      summary?: string;
      overridden?: boolean;
      overrideReason?: string;
    }
  | {
      ok: false;
      detail: string;
      classification: ExtractResultFailure['classification'];
      violationCode: ExtractResultFailure['violationCode'];
    };

export type EvaluatedNarrowVerificationVerdict = Extract<
  NarrowVerificationVerdictOutcome,
  { ok: true }
>;

export function evaluateNarrowVerificationVerdict(
  raw: NarrowVerificationResult,
  opts?: { originalFindingsCount?: number },
): EvaluatedNarrowVerificationVerdict {
  const normalizedVerdict = raw.verdict?.toUpperCase() === 'PASS' ? 'PASS' : 'FAIL';
  const evaluations = raw.findings_evaluations ?? [];
  const regressions = raw.obvious_regressions ?? [];
  const summary = raw.summary;

  // Anti-trap 1: If original findings existed, verifier cannot return empty evaluations
  if ((opts?.originalFindingsCount ?? 0) > 0 && evaluations.length === 0) {
    return {
      ok: true,
      verdict: 'FAIL',
      overridden: true,
      overrideReason:
        'Empty findings evaluations — verifier must evaluate all original blocking findings',
      evaluations,
      regressions,
      ...(summary !== undefined ? { summary } : {}),
    };
  }

  // Anti-trap 2: Any unresolved finding forces FAIL
  const unresolved = evaluations.filter((e) => e.resolved !== true);
  if (unresolved.length > 0 && normalizedVerdict === 'PASS') {
    return {
      ok: true,
      verdict: 'FAIL',
      overridden: true,
      overrideReason: `Unresolved blocking findings: ${unresolved.map((u) => u.finding).join(', ')}`,
      evaluations,
      regressions,
      ...(summary !== undefined ? { summary } : {}),
    };
  }

  // Anti-trap 3: Any obvious regressions force FAIL
  if (regressions.length > 0 && normalizedVerdict === 'PASS') {
    return {
      ok: true,
      verdict: 'FAIL',
      overridden: true,
      overrideReason: `Obvious regressions detected: ${regressions.join('; ')}`,
      evaluations,
      regressions,
      ...(summary !== undefined ? { summary } : {}),
    };
  }

  if (unresolved.length > 0 || regressions.length > 0) {
    return {
      ok: true,
      verdict: 'FAIL',
      evaluations,
      regressions,
      ...(summary !== undefined ? { summary } : {}),
    };
  }

  return {
    ok: true,
    verdict: normalizedVerdict,
    evaluations,
    regressions,
    ...(summary !== undefined ? { summary } : {}),
  };
}

export async function readNarrowVerificationVerdict(
  invocation: AgentInvocation,
  ports: { artifacts: ArtifactStore; repair?: StructuredResultRepairPort; agent?: unknown },
  opts?: ReadNarrowVerificationVerdictOptions,
): Promise<NarrowVerificationVerdictOutcome> {
  const r = await extractResult({
    invocation,
    ports,
    cwd: opts?.cwd,
    transcriptEvidence: opts?.transcriptEvidence,
    resultMeta: PHASE_RESULT_REGISTRY['narrow-verification'],
  });
  if (!r.ok) {
    return {
      ok: false,
      detail: r.detail,
      classification: r.classification,
      violationCode: r.violationCode,
    };
  }

  return evaluateNarrowVerificationVerdict(r.result, opts);
}

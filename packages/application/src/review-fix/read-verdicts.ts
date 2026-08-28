import type { AgentInvocation } from '@ai-sdlc/domain';
import { extractResult, type ExtractResultOutcome } from '../results/extract-result.js';
import type { ArtifactStore, StructuredResultRepairPort } from '../ports.js';
import type { WholePrReviewResult } from '../results/schemas/whole-pr-review.js';
import type { FixReviewResult } from '../results/schemas/fix-review.js';

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  // The spec/quality review prompts instruct reviewers to emit P0-P3
  // severities (see buildSpecReviewPrompt/buildQualityReviewPrompt in
  // apps/api/src/compose.ts), while blockOnSeverity config speaks
  // critical/high/medium/low. Without these aliases the gate can neither
  // block nor override P-labeled findings, so the reviewer's raw verdict
  // always rules and the severity dial is inert.
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

export type SpecReviewVerdict = 'pass' | 'partial' | 'fail';

export function readReviewVerdict(
  invocation: AgentInvocation,
  ports: { artifacts: ArtifactStore; repair?: StructuredResultRepairPort; agent?: unknown },
  opts: ReadReviewVerdictOptions & { allowFabricated: true },
): Promise<VerdictOutcome<'pass' | 'partial' | 'fail' | 'fabricated'>>;
export function readReviewVerdict(
  invocation: AgentInvocation,
  ports: { artifacts: ArtifactStore; repair?: StructuredResultRepairPort; agent?: unknown },
  opts?: ReadReviewVerdictOptions & { allowFabricated?: false },
): Promise<VerdictOutcome<'pass' | 'partial' | 'fail'>>;
export async function readReviewVerdict(
  invocation: AgentInvocation,
  ports: { artifacts: ArtifactStore; repair?: StructuredResultRepairPort; agent?: unknown },
  opts?: ReadReviewVerdictOptions & { allowFabricated?: boolean },
): Promise<VerdictOutcome<'pass' | 'partial' | 'fail' | 'fabricated'>> {
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
    verdict?: 'pass' | 'partial' | 'fail';
    result?: 'pass' | 'fail' | 'fabricated';
    findings?: Array<{
      severity: string;
      summary: string;
      file?: string;
      suggested_fix?: string;
      files?: string[];
    }>;
    requirements?: Array<{
      id: string;
      status: string;
      requirement: string;
      evidence?: string;
      notes?: string;
    }>;
    drift_items?: Array<{
      spec_symbol: string;
      actual_symbol: string;
      deviation_annotated: boolean;
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
    (raw.verdict === 'pass' || raw.result === 'pass') &&
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
      if (raw.verdict === 'pass' || (!raw.verdict && raw.result === 'pass')) {
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

    if (allBelow && (raw.verdict === 'fail' || raw.result === 'fail')) {
      return {
        ok: true,
        verdict: 'pass',
        overridden: true,
        offendingFindings: [],
      };
    }
  }

  if (raw.verdict === 'fail' || raw.verdict === 'partial') {
    const offendingFindings = raw.findings ?? [];
    if (raw.drift_items && raw.drift_items.some((d) => !d.deviation_annotated)) {
      const unannotatedDrift = raw.drift_items.filter((d) => !d.deviation_annotated);
      const driftFindings = unannotatedDrift.map(
        (d) =>
          ({
            severity: 'P0',
            summary: `Unannotated drift: spec prescribes \`${d.spec_symbol}\` but implementation uses \`${d.actual_symbol}\` with no deviation annotation in design phase`,
            file: d.files?.[0],
          }) as const,
      );
      return {
        ok: true,
        verdict: 'fail' as const,
        offendingFindings: [...offendingFindings, ...driftFindings],
      };
    }
    if (offendingFindings.length > 0) {
      return { ok: true, verdict: raw.verdict as 'pass' | 'partial' | 'fail', offendingFindings };
    }
    if (raw.verdict === 'fail') {
      return { ok: true, verdict: 'fail' as const, offendingFindings };
    }
    return { ok: true, verdict: 'partial' as const, offendingFindings };
  }

  if (raw.result === 'fail' && raw.findings && raw.findings.length > 0) {
    return { ok: true, verdict: 'fail', offendingFindings: raw.findings };
  }

  if (raw.drift_items && raw.drift_items.some((d) => !d.deviation_annotated)) {
    const unannotatedDrift = raw.drift_items.filter((d) => !d.deviation_annotated);
    const driftFindings = unannotatedDrift.map(
      (d) =>
        ({
          severity: 'P0',
          summary: `Unannotated drift: spec prescribes \`${d.spec_symbol}\` but implementation uses \`${d.actual_symbol}\` with no deviation annotation in design phase`,
          file: d.files?.[0],
        }) as const,
    );
    return { ok: true, verdict: 'fail' as const, offendingFindings: driftFindings };
  }

  return { ok: true, verdict: raw.verdict ?? raw.result ?? 'pass' };
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
    // The schema requires a non-empty rebuttal for done_no_fixes_needed;
    // carry it so the loop can append it to code-review.md when accepted.
    ...(fixResult.result === 'done_no_fixes_needed' ? { rebuttal: fixResult.rebuttal } : {}),
  };
}

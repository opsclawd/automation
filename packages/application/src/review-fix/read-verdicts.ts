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

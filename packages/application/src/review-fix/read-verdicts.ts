import type { AgentInvocation } from '@ai-sdlc/domain';
import { extractResult } from '../results/extract-result.js';
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
  const thresholdRank = severityRank(threshold) ?? SEVERITY_RANK['high']!;
  const offending = findings.filter((f) => (severityRank(f.severity) ?? Infinity) <= thresholdRank);
  return { blocked: offending.length > 0, offendingFindings: offending };
}

function allKnownSeveritiesBelowThreshold(
  findings: WholePrReviewResult['findings'],
  threshold: string,
): boolean {
  if (findings.length === 0) return false;
  const thresholdRank = severityRank(threshold) ?? SEVERITY_RANK['high']!;
  return findings.every((f) => {
    const rank = severityRank(f.severity);
    if (rank === undefined) return false;
    return rank > thresholdRank;
  });
}

export type VerdictOutcome<V> =
  | {
      ok: true;
      verdict: V;
      overridden?: boolean;
      offendingFindings?: Array<{ severity: string; summary: string }>;
      rebuttal?: string;
    }
  | { ok: false; detail: string };

export async function readReviewVerdict(
  invocation: AgentInvocation,
  ports: { artifacts: ArtifactStore; repair?: StructuredResultRepairPort; agent?: unknown },
  opts?: { blockOnSeverity?: string; cwd?: string },
): Promise<VerdictOutcome<'pass' | 'fail'>> {
  const r = await extractResult({ invocation, ports, cwd: opts?.cwd });
  if (!r.ok) return { ok: false, detail: r.detail };
  const result = r.result as WholePrReviewResult;

  if (opts?.blockOnSeverity && result.findings.length > 0) {
    const { blocked, offendingFindings } = severityGate(result.findings, opts.blockOnSeverity);

    if (blocked) {
      if (result.result === 'pass') {
        return {
          ok: true,
          verdict: 'fail',
          overridden: true,
          offendingFindings,
        };
      }
      return { ok: true, verdict: 'fail', offendingFindings };
    }

    const allBelow = allKnownSeveritiesBelowThreshold(result.findings, opts.blockOnSeverity);

    if (allBelow && result.result === 'fail') {
      return {
        ok: true,
        verdict: 'pass',
        overridden: true,
        offendingFindings: [],
      };
    }
  }

  // Any fail verdict must carry its findings so downstream consumers
  // (evidence check, rebuttal convergence, unfounded-pingpong detection)
  // can inspect them — not just the severity-gate override paths above.
  // See also: implRunFix in apps/api/src/compose.ts and arbiter-prompt.ts,
  // which consume the same findings via phase-segregated archives.
  if (result.result === 'fail' && result.findings.length > 0) {
    return { ok: true, verdict: 'fail', offendingFindings: result.findings };
  }

  return { ok: true, verdict: result.result };
}

export async function readFixVerdict(
  invocation: AgentInvocation,
  ports: { artifacts: ArtifactStore; repair?: StructuredResultRepairPort; agent?: unknown },
  opts?: { cwd?: string; repairExpectedHead?: string },
): Promise<VerdictOutcome<FixReviewResult['result']>> {
  const r = await extractResult({
    invocation,
    ports,
    cwd: opts?.cwd,
    repairExpectedHead: opts?.repairExpectedHead,
  });
  if (!r.ok) return { ok: false, detail: r.detail };
  const fixResult = r.result as FixReviewResult;
  return {
    ok: true,
    verdict: fixResult.result,
    // The schema requires a non-empty rebuttal for done_no_fixes_needed;
    // carry it so the loop can append it to code-review.md when accepted.
    ...(fixResult.result === 'done_no_fixes_needed' ? { rebuttal: fixResult.rebuttal } : {}),
  };
}

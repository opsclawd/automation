import type { AgentInvocation } from '@ai-sdlc/domain';
import { extractResult } from '../results/extract-result.js';
import type { ArtifactStore, AgentPort } from '../ports.js';
import type { WholePrReviewResult } from '../results/schemas/whole-pr-review.js';
import type { FixReviewResult } from '../results/schemas/fix-review.js';

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function severityGate(
  findings: WholePrReviewResult['findings'],
  threshold: string,
): { blocked: boolean; offendingFindings: WholePrReviewResult['findings'] } {
  const thresholdRank = SEVERITY_RANK[threshold] ?? SEVERITY_RANK['high']!;
  const offending = findings.filter(
    (f) => (SEVERITY_RANK[f.severity] ?? Infinity) <= thresholdRank,
  );
  return { blocked: offending.length > 0, offendingFindings: offending };
}

export type VerdictOutcome<V> =
  | {
      ok: true;
      verdict: V;
      overridden?: boolean;
      offendingFindings?: Array<{ severity: string; summary: string }>;
    }
  | { ok: false; detail: string };

export async function readReviewVerdict(
  invocation: AgentInvocation,
  ports: { artifacts: ArtifactStore; agent: AgentPort },
  opts?: { blockOnSeverity?: string },
): Promise<VerdictOutcome<'pass' | 'fail'>> {
  const r = await extractResult({ invocation, ports });
  if (!r.ok) return { ok: false, detail: r.detail };
  const result = r.result as WholePrReviewResult;

  if (result.result === 'pass' && opts?.blockOnSeverity && result.findings.length > 0) {
    const { blocked, offendingFindings } = severityGate(result.findings, opts.blockOnSeverity);
    if (blocked) {
      return {
        ok: true,
        verdict: 'fail',
        overridden: true,
        offendingFindings,
      };
    }
  }

  return { ok: true, verdict: result.result };
}

export async function readFixVerdict(
  invocation: AgentInvocation,
  ports: { artifacts: ArtifactStore; agent: AgentPort },
): Promise<VerdictOutcome<FixReviewResult['result']>> {
  const r = await extractResult({ invocation, ports });
  if (!r.ok) return { ok: false, detail: r.detail };
  return { ok: true, verdict: (r.result as FixReviewResult).result };
}

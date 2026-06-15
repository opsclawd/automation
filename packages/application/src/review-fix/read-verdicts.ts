import type { AgentInvocation } from '@ai-sdlc/domain';
import { extractResult } from '../results/extract-result.js';
import type { ArtifactStore, AgentPort } from '../ports.js';
import type { WholePrReviewResult } from '../results/schemas/whole-pr-review.js';
import type { FixReviewResult } from '../results/schemas/fix-review.js';

export type VerdictOutcome<V> = { ok: true; verdict: V } | { ok: false; detail: string };

export async function readReviewVerdict(
  invocation: AgentInvocation,
  ports: { artifacts: ArtifactStore; agent: AgentPort },
): Promise<VerdictOutcome<'pass' | 'fail'>> {
  const r = await extractResult({ invocation, ports });
  if (!r.ok) return { ok: false, detail: r.detail };
  return { ok: true, verdict: (r.result as WholePrReviewResult).result };
}

export async function readFixVerdict(
  invocation: AgentInvocation,
  ports: { artifacts: ArtifactStore; agent: AgentPort },
): Promise<VerdictOutcome<FixReviewResult['result']>> {
  const r = await extractResult({ invocation, ports });
  if (!r.ok) return { ok: false, detail: r.detail };
  return { ok: true, verdict: (r.result as FixReviewResult).result };
}

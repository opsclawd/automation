import { RunId, parseSeverity } from '@ai-sdlc/domain';
import type { PrReviewRepositoryPort } from '../ports/pr-review-repository-port.js';

export interface MergeReadinessResult {
  isReady: boolean;
  reason?: string | undefined;
  blockedComments: Array<{ commentId: number; reason: string }>;
  unverifiedP1Comments: Array<{ commentId: number; severity: string }>;
}

export interface CheckMergeReadinessDeps {
  prReviewRepo: PrReviewRepositoryPort;
}

export class CheckMergeReadiness {
  constructor(private readonly deps: CheckMergeReadinessDeps) {}

  async execute(runId: RunId): Promise<MergeReadinessResult> {
    const comments = this.deps.prReviewRepo.listComments(runId);

    const blockedComments = comments
      .filter((c) => c.state === 'blocked')
      .map((c) => ({ commentId: c.commentId, reason: c.blockedReason || 'unknown' }));

    const unverifiedP1Comments = comments
      .filter((c) => c.state !== 'processed' && c.state !== 'blocked')
      .filter((c) => {
        const severity = c.severity || parseSeverity(c.body);
        return severity === 'critical' || severity === 'high';
      })
      .map((c) => ({
        commentId: c.commentId,
        severity: c.severity || parseSeverity(c.body) || 'high',
      }));

    const isReady = blockedComments.length === 0 && unverifiedP1Comments.length === 0;

    let reason: string | undefined;
    if (!isReady) {
      const reasons: string[] = [];
      if (blockedComments.length > 0) {
        reasons.push(`${blockedComments.length} blocked comment(s)`);
      }
      if (unverifiedP1Comments.length > 0) {
        reasons.push(`${unverifiedP1Comments.length} unverified P1 comment(s)`);
      }
      reason = reasons.join(', ');
    }

    return {
      isReady,
      reason,
      blockedComments,
      unverifiedP1Comments,
    };
  }
}

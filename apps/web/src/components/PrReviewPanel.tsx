'use client';

import { useEffect, useState } from 'react';
import { listPrReview, type PrReviewData } from '@/lib/api-client';
import { sortCommentsUnresolvedFirst } from '@/lib/pr-review';

const STATE_PILL: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  replied: 'bg-blue-100 text-blue-800',
  processed: 'bg-green-100 text-green-800',
  blocked: 'bg-red-100 text-red-800',
};

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`text-xs ${ok ? 'text-green-700' : 'text-slate-400'}`}>
      {ok ? '\u2713' : '\u25CB'} {label}
    </span>
  );
}

export function PrReviewPanel({
  repositoryId,
  runUuid,
}: {
  repositoryId: string;
  runUuid: string;
}) {
  const [data, setData] = useState<PrReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listPrReview(repositoryId, runUuid)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [repositoryId, runUuid]);

  if (error) return <div className="text-sm text-red-600">Failed to load PR review: {error}</div>;
  if (data === null) return <div className="text-sm text-slate-500">Loading PR review...</div>;
  if (data.comments.length === 0 && data.pollAttempts.length === 0)
    return <div className="text-sm text-slate-500">No PR review activity for this run.</div>;

  const latest = data.pollAttempts[data.pollAttempts.length - 1];
  const comments = sortCommentsUnresolvedFirst(data.comments);

  return (
    <div className="space-y-4">
      {/* Poll status panel */}
      <div className="rounded border bg-slate-50 p-3 text-sm">
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <span>
            <b>Polls run:</b> {data.pollAttempts.length}
          </span>
          {latest != null && (
            <span>
              <b>Latest:</b> {latest.status}
            </span>
          )}
          {latest?.terminalState != null && (
            <span>
              <b>Terminal:</b> {latest.terminalState}
            </span>
          )}
          {latest?.nextPollAt != null && (
            <span>
              <b>Next poll:</b> {new Date(latest.nextPollAt).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {/* Comment cards */}
      <ul className="space-y-2">
        {comments.map((cm) => (
          <li key={cm.commentId} className="rounded border p-3 text-sm space-y-1">
            <div className="flex items-center gap-2">
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${STATE_PILL[cm.state] ?? ''}`}
              >
                {cm.state}
              </span>
              <code className="font-mono text-xs">
                {cm.path}:{cm.line}
              </code>
              <span className="text-slate-500">@{cm.reviewer}</span>
              <span className="ml-auto text-xs text-slate-400">#{cm.commentId}</span>
            </div>
            <p className="text-slate-700 whitespace-pre-wrap">{cm.body}</p>
            {cm.outcome != null && (
              <div className="text-xs text-slate-600">
                <b>Agent action:</b> {cm.outcome}
              </div>
            )}
            {cm.replyBody != null && (
              <div className="rounded bg-slate-50 p-2 text-xs text-slate-700">
                <b>Reply:</b> {cm.replyBody}
              </div>
            )}
            {cm.blockedReason != null && (
              <div className="text-xs text-red-700">
                <b>Blocked:</b> {cm.blockedReason}
              </div>
            )}
            <div className="flex gap-3 pt-1">
              <Check ok={cm.commitVerified} label="commit" />
              <Check ok={cm.replyVerified} label="reply" />
              <Check ok={cm.buildVerified} label="build" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

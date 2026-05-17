'use client';

import { useEffect, useRef, useState } from 'react';

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES = new Set(['passed', 'failed', 'cancelled']);
const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4319';

interface LiveLogViewerProps {
  runId: string;
  runStatus: string;
  initialContent: string;
}

export function LiveLogViewer({ runId, runStatus, initialContent }: LiveLogViewerProps) {
  const [content, setContent] = useState(initialContent);
  const [status, setStatus] = useState(runStatus);
  const preRef = useRef<HTMLPreElement>(null);
  const isUserScrollingRef = useRef(false);

  useEffect(() => {
    if (TERMINAL_STATUSES.has(status)) return;

    const interval = setInterval(async () => {
      try {
        const logRes = await fetch(`${apiBaseUrl}/api/runs/${runId}/artifacts/combined.log`);
        if (logRes.ok) {
          setContent(await logRes.text());
        } else if (logRes.status === 404) {
          setContent('(waiting for logs...)');
        }
      } catch {
        // keep last successful content on network error
      }

      try {
        const runRes = await fetch(`${apiBaseUrl}/api/runs/${runId}`);
        if (runRes.ok) {
          const { run } = (await runRes.json()) as { run: { status: string } };
          setStatus(run.status);
        } else if (runRes.status === 404) {
          setContent('(run deleted)');
          setStatus('cancelled');
        }
      } catch {
        // keep last known status on network error
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [runId, status]);

  useEffect(() => {
    if (isUserScrollingRef.current) return;
    if (!preRef.current) return;
    preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [content]);

  function handleScroll() {
    const el = preRef.current;
    if (!el) return;
    isUserScrollingRef.current = el.scrollTop + el.clientHeight < el.scrollHeight - 20;
  }

  return (
    <section>
      <h2 className="font-semibold mb-2">Logs</h2>
      <pre
        ref={preRef}
        onScroll={handleScroll}
        className="rounded border bg-black text-green-200 p-3 overflow-auto max-h-[480px] text-xs"
      >
        {content || '(no combined.log)'}
      </pre>
    </section>
  );
}

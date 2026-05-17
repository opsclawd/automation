'use client';

import { useEffect, useRef, useState } from 'react';

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES = new Set(['passed', 'failed', 'cancelled']);

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

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const logRes = await fetch(`/api/runs/${runId}/artifacts/combined.log`, {
          signal: controller.signal,
        });
        if (logRes.ok && !controller.signal.aborted) {
          setContent(await logRes.text());
        } else if (logRes.status === 404 && !controller.signal.aborted) {
          setContent('(waiting for logs...)');
        }
      } catch {
        // keep last successful content on network error
      }

      if (controller.signal.aborted) return;

      try {
        const runRes = await fetch(`/api/runs/${runId}`, {
          signal: controller.signal,
        });
        if (runRes.ok && !controller.signal.aborted) {
          const { run } = (await runRes.json()) as { run: { status: string } };
          setStatus(run.status);
        } else if (runRes.status === 404 && !controller.signal.aborted) {
          setContent('(run deleted)');
          setStatus('cancelled');
        }
      } catch {
        // keep last known status on network error
      }

      if (!controller.signal.aborted) {
        timeoutId = setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    timeoutId = setTimeout(poll, POLL_INTERVAL_MS);

    return () => {
      controller.abort();
      clearTimeout(timeoutId);
    };
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
      <h2 className="font-semibold mb-2">
        Logs <span className="text-sm rounded bg-slate-200 px-2 py-0.5 ml-2">{status}</span>
      </h2>
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

'use client';
import { useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { formatBytes } from '@/lib/format';

interface ArtifactViewerProps {
  runId: string;
  fileName: string;
  fileSize?: number;
}

type ViewState = 'closed' | 'loading' | 'loaded' | 'error' | 'no-preview';

const EXT_RENDERERS: Record<string, { label: string }> = {
  '.md': { label: 'Markdown' },
  '.json': { label: 'JSON' },
  '.log': { label: 'Log' },
  '.diff': { label: 'Diff' },
  '.txt': { label: 'Text' },
};

function getExt(path: string): string {
  const i = path.lastIndexOf('.');
  return i >= 0 ? path.slice(i).toLowerCase() : '';
}

export function ArtifactViewer({ runId, fileName, fileSize }: ArtifactViewerProps) {
  const [state, setState] = useState<ViewState>('closed');
  const [content, setContent] = useState<string>('');
  const reqId = useRef(0);

  const ext = getExt(fileName);
  const renderer = EXT_RENDERERS[ext];

  async function handleToggle() {
    if (state === 'loaded' || state === 'loading' || state === 'no-preview') {
      reqId.current++;
      setState('closed');
      setContent('');
      return;
    }

    if (!renderer) {
      setState('no-preview');
      return;
    }

    const myId = ++reqId.current;
    setState('loading');
    try {
      const r = await fetch(`/api/runs/${runId}/artifacts/${encodeURIComponent(fileName)}`, {
        cache: 'no-store',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (reqId.current !== myId) return;
      const text = await r.text();
      if (reqId.current !== myId) return;
      setContent(text);
      setState('loaded');
    } catch {
      if (reqId.current !== myId) return;
      setState('error');
    }
  }

  return (
    <div className="w-full">
      <button
        onClick={handleToggle}
        className="text-blue-600 underline text-left hover:text-blue-800"
      >
        {fileName}
      </button>
      {fileSize !== undefined && (
        <span className="ml-2 text-slate-500">{formatBytes(fileSize)}</span>
      )}
      <a
        href={`/api/runs/${runId}/artifacts/${encodeURIComponent(fileName)}`}
        download
        className="ml-2 text-xs text-slate-400 hover:text-slate-600"
      >
        Download
      </a>

      {state === 'loading' && <div className="mt-2 text-sm text-slate-500">Loading...</div>}

      {state === 'error' && (
        <div className="mt-2 text-sm text-red-600">Failed to load artifact.</div>
      )}

      {state === 'loaded' && renderer?.label === 'Markdown' && (
        <div className="mt-2 rounded border bg-white p-3 text-sm prose prose-sm max-w-none">
          <ReactMarkdown>{content}</ReactMarkdown>
        </div>
      )}

      {state === 'loaded' && renderer?.label === 'JSON' && (
        <pre
          className="mt-2 rounded border bg-slate-50 p-3 text-sm overflow-x-auto"
          aria-label={`JSON output for ${fileName}`}
        >
          {(() => {
            try {
              return JSON.stringify(JSON.parse(content), null, 2);
            } catch {
              return content;
            }
          })()}
        </pre>
      )}

      {state === 'loaded' && (renderer?.label === 'Log' || renderer?.label === 'Text') && (
        <pre
          className="mt-2 rounded border bg-gray-900 p-3 text-sm text-green-300 overflow-x-auto font-mono"
          aria-label={`Log output for ${fileName}`}
        >
          {content}
        </pre>
      )}

      {state === 'loaded' && renderer?.label === 'Diff' && (
        <pre
          className="mt-2 rounded border bg-gray-50 p-3 text-sm overflow-x-auto font-mono"
          aria-label={`Diff output for ${fileName}`}
        >
          {content.split('\n').map((line, i) => {
            let cls = '';
            if (line.startsWith('+')) cls = 'text-green-700 bg-green-50';
            else if (line.startsWith('-')) cls = 'text-red-700 bg-red-50';
            else if (line.startsWith('@@')) cls = 'text-blue-600';
            return (
              <div key={i} className={cls}>
                {line}
              </div>
            );
          })}
        </pre>
      )}

      {state === 'no-preview' && (
        <div className="mt-2 text-sm text-slate-500">
          Preview not available for this file type.{' '}
          <a
            href={`/api/runs/${runId}/artifacts/${encodeURIComponent(fileName)}`}
            download
            className="text-blue-600 underline"
          >
            Download file
          </a>
        </div>
      )}
    </div>
  );
}

import { notFound } from 'next/navigation';
import { getRun, listArtifacts, getArtifact } from '@/lib/api-client';
import { formatDuration, formatBytes } from '@/lib/format';
import { LiveLogViewer } from './LiveLogViewer';

export const dynamic = 'force-dynamic';

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let run, failure;
  try {
    ({ run, failure } = await getRun(id));
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes(': 404')) notFound();
    throw e;
  }

  const files = await listArtifacts(id);
  const combined = files.find((f) => f.path === 'combined.log');
  const combinedContent = combined ? await getArtifact(id, 'combined.log') : '';

  return (
    <main className="mx-auto max-w-5xl p-6 space-y-6">
      <header className="flex flex-wrap gap-4 items-baseline">
        <h1 className="text-2xl font-semibold font-mono">{run.displayId}</h1>
        <span className="text-sm text-slate-600">Issue #{run.issueNumber}</span>
        <span className="text-sm text-slate-600">{formatDuration(run.durationMs)}</span>
      </header>

      <LiveLogViewer runId={run.uuid} runStatus={run.status} initialContent={combinedContent} />

      <section>
        <h2 className="font-semibold mb-2">Artifacts</h2>
        <ul className="text-sm space-y-1">
          {files.map((f) => (
            <li key={f.path}>
              <a
                className="text-blue-600 underline"
                href={`/api/runs/${run.uuid}/artifacts/${encodeURIComponent(f.path)}`}
              >
                {f.path}
              </a>
              <span className="ml-2 text-slate-500">{formatBytes(f.size)}</span>
            </li>
          ))}
        </ul>
      </section>

      {failure && (
        <section>
          <h2 className="font-semibold mb-2 text-red-700">Failure</h2>
          <div className="rounded border bg-red-50 p-3 text-sm space-y-1">
            <div>
              <b>Kind:</b> {failure.kind}
            </div>
            {failure.phase != null && (
              <div>
                <b>Phase:</b> {failure.phase}
              </div>
            )}
            {failure.exitCode !== undefined && (
              <div>
                <b>Exit code:</b> {failure.exitCode}
              </div>
            )}
            <div>
              <b>Message:</b> <pre className="inline whitespace-pre-wrap">{failure.message}</pre>
            </div>
            <div>
              <b>Suggested action:</b> {failure.suggestedAction}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}

import Link from 'next/link';
import { listRuns } from '@/lib/api-client';
import { formatDuration } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const runs = await listRuns();

  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-semibold mb-4">Runs</h1>
      <div className="overflow-x-auto rounded border bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="text-left px-3 py-2">Display ID</th>
              <th className="text-left px-3 py-2">Issue</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Phase</th>
              <th className="text-left px-3 py-2">Started</th>
              <th className="text-left px-3 py-2">Duration</th>
              <th className="text-left px-3 py-2">Failure</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.uuid} className="border-t">
                <td className="px-3 py-2 font-mono">
                  <Link className="text-blue-600 underline" href={`/runs/${r.uuid}`}>
                    {r.displayId}
                  </Link>
                </td>
                <td className="px-3 py-2">#{r.issueNumber}</td>
                <td className="px-3 py-2">{r.status}</td>
                <td className="px-3 py-2">{r.currentPhase ?? '—'}</td>
                <td className="px-3 py-2">{new Date(r.startedAt).toLocaleString()}</td>
                <td className="px-3 py-2">{formatDuration(r.durationMs)}</td>
                <td className="px-3 py-2 text-red-700">{r.failureReason ?? ''}</td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-slate-500" colSpan={7}>
                  No runs yet. Start one with <code>orchestrator run --issue &lt;N&gt;</code>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

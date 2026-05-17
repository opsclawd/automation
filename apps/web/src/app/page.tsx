import Link from 'next/link';
import { listRuns } from '@/lib/api-client';
import { formatDuration } from '@/lib/format';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

export default async function Page(props: { searchParams?: Promise<{ page?: string }> }) {
  const searchParams = await props.searchParams;
  const page = Math.max(1, parseInt(searchParams?.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const { runs, total } = await listRuns({ limit: PAGE_SIZE, offset });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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

      {totalPages > 1 && (
        <nav className="flex items-center justify-between mt-4 text-sm" aria-label="Pagination">
          <span className="text-slate-600">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link
                href={`/?page=${page - 1}`}
                className="rounded border px-3 py-1.5 text-slate-700 hover:bg-slate-50"
              >
                Previous
              </Link>
            ) : (
              <span className="rounded border px-3 py-1.5 text-slate-300">Previous</span>
            )}
            {page < totalPages ? (
              <Link
                href={`/?page=${page + 1}`}
                className="rounded border px-3 py-1.5 text-slate-700 hover:bg-slate-50"
              >
                Next
              </Link>
            ) : (
              <span className="rounded border px-3 py-1.5 text-slate-300">Next</span>
            )}
          </div>
        </nav>
      )}
    </main>
  );
}

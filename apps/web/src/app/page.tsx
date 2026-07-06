import Link from 'next/link';
import { listRuns, listRepositories } from '@/lib/api-client';
import { formatDuration } from '@/lib/format';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

export default async function Page(props: {
  searchParams?: Promise<{ page?: string; repoId?: string }>;
}) {
  const searchParams = await props.searchParams;
  const page = Math.max(1, parseInt(searchParams?.page ?? '1', 10) || 1);
  const repoId = searchParams?.repoId;
  const offset = (page - 1) * PAGE_SIZE;
  const { runs, total } = await listRuns({ limit: PAGE_SIZE, offset, repoId });
  const { repositories } = await listRepositories();
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-semibold">Runs</h1>
        {repositories.length > 1 && (
          <div className="flex items-center gap-2">
            <label htmlFor="repo-filter" className="text-sm font-medium">
              Repository:
            </label>
            <select
              id="repo-filter"
              className="text-sm border rounded p-1"
              defaultValue={repoId ?? ''}
              onChange="window.location.href = this.value ? `?repoId=${this.value}` : '/'"
              // In Next.js Server Components we can't use onChange easily without a client component.
              // For simplicity in this edit, I'll use a hack or just leave it as a static select for now
              // if I don't want to create a new client component.
              // Let's use a simple Link-based "filter" for now or just an HTML select that works with a form.
            >
              <option value="">All Repositories</option>
              {repositories.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.fullName}
                </option>
              ))}
            </select>
            <script
              dangerouslySetInnerHTML={{
                __html: `
              document.getElementById('repo-filter').onchange = function() {
                const val = this.value;
                const url = new URL(window.location.href);
                if (val) url.searchParams.set('repoId', val);
                else url.searchParams.delete('repoId');
                url.searchParams.delete('page');
                window.location.href = url.toString();
              };
            `,
              }}
            />
          </div>
        )}
      </div>

      <div className="overflow-x-auto rounded border bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="text-left px-3 py-2">Display ID</th>
              <th className="text-left px-3 py-2">Repository</th>
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
                <td className="px-3 py-2 truncate max-w-[150px]" title={r.repoId}>
                  {r.repoId}
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

import Link from 'next/link';
import { RunDto, repositoryHref, repositoryRunHref } from '../lib/api-client';
import { formatDuration } from '../lib/format';

interface RunTableProps {
  runs: RunDto[];
  repositoryMap: Record<string, string>;
  showRepository?: boolean;
}

export default function RunTable({ runs, repositoryMap, showRepository = false }: RunTableProps) {
  return (
    <div className="overflow-x-auto rounded border bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-100">
          <tr>
            <th className="text-left px-3 py-2">Display ID</th>
            {showRepository && <th className="text-left px-3 py-2">Repository</th>}
            <th className="text-left px-3 py-2">Issue</th>
            <th className="text-left px-3 py-2">Status</th>
            <th className="text-left px-3 py-2">Phase</th>
            <th className="text-left px-3 py-2">Started</th>
            <th className="text-left px-3 py-2">Duration</th>
            <th className="text-left px-3 py-2">Failure</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const repoName = repositoryMap[r.repoId];
            return (
              <tr key={r.uuid} className="border-t">
                <td className="px-3 py-2 font-mono">
                  <Link
                    className="text-blue-600 underline"
                    href={repositoryRunHref(r.repoId, r.uuid)}
                  >
                    {r.displayId}
                  </Link>
                </td>
                {showRepository && (
                  <td className="px-3 py-2">
                    {repoName ? (
                      <Link className="text-blue-600 underline" href={repositoryHref(r.repoId)}>
                        {repoName}
                      </Link>
                    ) : (
                      <span className="text-slate-500">Unregistered repository ({r.repoId})</span>
                    )}
                  </td>
                )}
                <td className="px-3 py-2 font-semibold">#{r.issueNumber}</td>
                <td className="px-3 py-2">{r.status}</td>
                <td className="px-3 py-2">{r.currentPhase ?? '—'}</td>
                <td className="px-3 py-2">{new Date(r.startedAt).toLocaleString()}</td>
                <td className="px-3 py-2">{formatDuration(r.durationMs)}</td>
                <td className="px-3 py-2 text-red-700">{r.failureReason ?? ''}</td>
              </tr>
            );
          })}
          {runs.length === 0 && (
            <tr>
              <td className="px-3 py-4 text-slate-500 text-center" colSpan={showRepository ? 8 : 7}>
                No runs found.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

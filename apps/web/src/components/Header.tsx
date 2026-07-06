import { getMeta } from '@/lib/api-client';
import Link from 'next/link';

export default async function Header() {
  let meta = { repoFullName: '', targetRepoRoot: '' };
  try {
    meta = await getMeta();
  } catch (err) {
    console.error('Failed to fetch meta:', err);
  }

  return (
    <header className="bg-slate-800 text-white p-4 mb-6 shadow-sm">
      <div className="mx-auto max-w-5xl flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-xl font-bold hover:text-slate-200">
            Orchestrator
          </Link>
          {meta.targetRepoRoot && (
            <div className="flex items-center gap-2 text-sm border-l border-slate-600 pl-4">
              <span className="text-slate-400">Target:</span>
              {meta.repoFullName && (
                <span className="font-mono text-slate-100">{meta.repoFullName}</span>
              )}
              <span className="text-slate-500 text-xs truncate max-w-[200px]" title={meta.targetRepoRoot}>
                ({meta.targetRepoRoot})
              </span>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

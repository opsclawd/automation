import { listRepositories, RepositoryDto } from '@/lib/api-client';
import Link from 'next/link';
import RepositorySelector from './RepositorySelector';
import { Suspense } from 'react';

export default async function Header() {
  let repositories: RepositoryDto[] = [];
  try {
    repositories = await listRepositories({ all: 1 });
  } catch (err) {
    console.error('Failed to fetch repositories:', err);
  }

  return (
    <header className="bg-slate-800 text-white p-4 mb-6 shadow-sm">
      <div className="mx-auto max-w-5xl flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-xl font-bold hover:text-slate-200">
            Orchestrator
          </Link>
        </div>
        <Suspense fallback={<div className="text-sm text-slate-400">Loading...</div>}>
          <RepositorySelector repositories={repositories} />
        </Suspense>
      </div>
    </header>
  );
}

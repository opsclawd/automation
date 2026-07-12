'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { RepositoryDto, repositoryHref } from '../lib/api-client';

interface RepositorySelectorProps {
  repositories: RepositoryDto[];
}

export default function RepositorySelector({ repositories }: RepositorySelectorProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  let activeId = '';
  if (pathname) {
    const match = pathname.match(/^\/repositories\/([^/]+)/);
    if (match && match[1]) {
      activeId = decodeURIComponent(match[1]);
    }
  }
  if (!activeId && searchParams) {
    activeId = searchParams.get('repositoryId') || '';
  }

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (!val) {
      router.push('/');
    } else {
      router.push(repositoryHref(val));
    }
  };

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="repo-selector" className="text-sm font-medium text-slate-300">
        Repository:
      </label>
      <select
        id="repo-selector"
        value={activeId}
        onChange={handleChange}
        className="bg-slate-700 text-white rounded px-2 py-1 text-sm border border-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        <option value="">Global</option>
        {repositories.map((repo) => {
          let statusText = '';
          if (!repo.enabled) {
            statusText = ' (disabled)';
          } else if (repo.healthStatus !== 'healthy') {
            statusText = ` (${repo.healthStatus})`;
          }
          return (
            <option key={repo.id} value={repo.id}>
              {repo.fullName}
              {statusText}
            </option>
          );
        })}
      </select>
    </div>
  );
}

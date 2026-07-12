'use client';

import { useRouter } from 'next/navigation';
import { RepositoryDto, RUN_STATUSES } from '../lib/api-client';

interface RunFiltersProps {
  repositories: RepositoryDto[];
  currentRepositoryId?: string | undefined;
  currentStatus?: string | undefined;
}

export default function RunFilters({
  repositories,
  currentRepositoryId = '',
  currentStatus = '',
}: RunFiltersProps) {
  const router = useRouter();

  const handleFilterChange = (
    e: React.ChangeEvent<HTMLSelectElement>,
    paramName: 'repositoryId' | 'status',
  ) => {
    const newVal = e.target.value;
    const params = new URLSearchParams();

    let nextRepoId = currentRepositoryId || '';
    let nextStatus = currentStatus || '';

    if (paramName === 'repositoryId') {
      nextRepoId = newVal;
    } else {
      nextStatus = newVal;
    }

    const route = nextRepoId ? `/repositories/${nextRepoId}` : '/';

    if (nextStatus) {
      params.set('status', nextStatus);
    }

    const query = params.toString();
    router.push(`${route}${query ? `?${query}` : ''}`);
  };

  const formAction = currentRepositoryId ? `/repositories/${currentRepositoryId}` : '/';

  return (
    <form
      method="GET"
      action={formAction}
      className="flex flex-wrap gap-4 items-center mb-6 bg-slate-50 p-4 rounded border"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="filter-repo" className="text-xs font-semibold text-slate-600">
          Repository
        </label>
        <select
          id="filter-repo"
          name="repositoryId"
          value={currentRepositoryId || ''}
          onChange={(e) => handleFilterChange(e, 'repositoryId')}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">All Repositories</option>
          {repositories.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.fullName}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="filter-status" className="text-xs font-semibold text-slate-600">
          Status
        </label>
        <select
          id="filter-status"
          name="status"
          value={currentStatus || ''}
          onChange={(e) => handleFilterChange(e, 'status')}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">All Statuses</option>
          {RUN_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </div>

      <noscript>
        <button
          type="submit"
          className="mt-5 rounded bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-500"
        >
          Apply Filters
        </button>
      </noscript>
    </form>
  );
}

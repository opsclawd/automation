import { listRuns, listRepositories } from '@/lib/api-client';
import RunFilters from '@/components/RunFilters';
import RunTable from '@/components/RunTable';
import RunPagination from '@/components/RunPagination';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

export default async function Page(props: {
  searchParams?: Promise<{ repositoryId?: string; status?: string; page?: string }>;
}) {
  const searchParams = await props.searchParams;
  const repositoryId = searchParams?.repositoryId || undefined;
  const status = searchParams?.status || undefined;
  const page = Math.max(1, parseInt(searchParams?.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const repositories = await listRepositories({ all: 1 });
  const repositoryMap: Record<string, string> = {};
  for (const r of repositories) {
    repositoryMap[r.id] = r.fullName;
  }

  const listParams: {
    limit: number;
    offset: number;
    repositoryId?: string;
    status?: string;
  } = {
    limit: PAGE_SIZE,
    offset,
  };

  if (repositoryId !== undefined) {
    listParams.repositoryId = repositoryId;
  }
  if (status !== undefined) {
    listParams.status = status;
  }

  const { runs, total } = await listRuns(listParams);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-semibold mb-4">Runs</h1>

      <RunFilters
        repositories={repositories}
        currentRepositoryId={repositoryId}
        currentStatus={status}
        actionRoute="/"
      />

      <RunTable runs={runs} repositoryMap={repositoryMap} showRepository={true} />

      {totalPages > 1 && (
        <RunPagination
          page={page}
          totalPages={totalPages}
          currentRepositoryId={repositoryId}
          currentStatus={status}
          actionRoute="/"
        />
      )}
    </main>
  );
}

import { listRuns, listRepositories } from '@/lib/api-client';
import RunFilters from '@/components/RunFilters';
import RunTable from '@/components/RunTable';
import RunPagination from '@/components/RunPagination';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

export default async function Page(props: {
  params: Promise<{ repositoryId: string }>;
  searchParams?: Promise<{ status?: string; page?: string }>;
}) {
  const { repositoryId } = await props.params;
  const searchParams = await props.searchParams;
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
    repositoryId,
  };

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
      />

      <RunTable runs={runs} repositoryMap={repositoryMap} showRepository={true} />

      {totalPages > 1 && (
        <RunPagination
          page={page}
          totalPages={totalPages}
          currentRepositoryId={repositoryId}
          currentStatus={status}
        />
      )}
    </main>
  );
}

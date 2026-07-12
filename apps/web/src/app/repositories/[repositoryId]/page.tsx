import { notFound } from 'next/navigation';
import { listRuns, listRepositories, getRepository, getStatusMetrics } from '@/lib/api-client';
import { getRepositoryAvailability, AvailabilityResult } from '@/lib/repository-availability';
import RepositoryAvailabilityBadge from '@/components/RepositoryAvailabilityBadge';
import RefreshRepositoryHealthButton from '@/components/RefreshRepositoryHealthButton';
import StatusMetrics from '@/components/StatusMetrics';
import NewRunForm from '@/components/NewRunForm';
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

  // Build scoped listParams using ONLY the route parameter repositoryId
  const listParams: {
    limit: number;
    offset: number;
    repositoryId: string;
    status?: string;
  } = {
    limit: PAGE_SIZE,
    offset,
    repositoryId,
  };

  if (status !== undefined) {
    listParams.status = status;
  }

  // Load repository details, repositories list, runs list, and metrics in parallel
  let repository;
  let repositories;
  let runsResult;
  let metrics;

  try {
    [repository, repositories, runsResult, metrics] = await Promise.all([
      getRepository(repositoryId).catch((e) => {
        if (e instanceof Error && (e.message.includes(': 404') || e.message.includes('404'))) {
          notFound();
        }
        throw e;
      }),
      listRepositories({ all: 1 }),
      listRuns(listParams),
      getStatusMetrics(repositoryId),
    ]);
  } catch (e: unknown) {
    if (e instanceof Error && (e.message.includes(': 404') || e.message.includes('404'))) {
      notFound();
    }
    throw e;
  }

  const { runs, total } = runsResult;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Compute availability results for all registered repositories to pass to NewRunForm
  const availabilityResults: Record<string, AvailabilityResult> = {};
  for (const r of repositories) {
    availabilityResults[r.id] = getRepositoryAvailability(r);
  }

  const repositoryMap: Record<string, string> = {};
  for (const r of repositories) {
    repositoryMap[r.id] = r.fullName;
  }

  return (
    <main className="mx-auto max-w-5xl p-6 space-y-6">
      {/* Header / Identity Details */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
          <div>
            <h1 className="text-2xl font-bold text-white mb-1" data-testid="repo-title">
              {repository.fullName}
            </h1>
            <p className="text-sm text-slate-400">
              Remote: <span className="font-mono text-slate-300">{repository.remoteUrl}</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <RepositoryAvailabilityBadge repository={repository} />
            <RefreshRepositoryHealthButton repositoryId={repository.id} />
          </div>
        </div>

        {/* Configuration / Timestamps Info Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-slate-300 border-t border-slate-800 pt-4">
          <div className="space-y-2">
            <div>
              <span className="font-semibold text-slate-400">Repository ID: </span>
              <span className="font-mono text-xs">{repository.id}</span>
            </div>
            <div>
              <span className="font-semibold text-slate-400">Local Base Path: </span>
              <span className="font-mono text-xs text-slate-300">{repository.localBasePath}</span>
            </div>
            <div>
              <span className="font-semibold text-slate-400">Default Branch: </span>
              <span className="text-slate-300">{repository.defaultBranch}</span>
            </div>
            <div>
              <span className="font-semibold text-slate-400">Owner: </span>
              <span>{repository.owner}</span>
            </div>
            <div>
              <span className="font-semibold text-slate-400">Name: </span>
              <span>{repository.name}</span>
            </div>
          </div>

          <div className="space-y-2">
            <div>
              <span className="font-semibold text-slate-400">Enabled: </span>
              <span className={repository.enabled ? 'text-emerald-400' : 'text-rose-400'}>
                {repository.enabled ? 'Yes' : 'No'}
              </span>
            </div>
            <div>
              <span className="font-semibold text-slate-400">Created At: </span>
              <span>{new Date(repository.createdAt).toLocaleString()}</span>
            </div>
            <div>
              <span className="font-semibold text-slate-400">Updated At: </span>
              <span>{new Date(repository.updatedAt).toLocaleString()}</span>
            </div>
            <div>
              <span className="font-semibold text-slate-400">Last Health Check: </span>
              <span>
                {repository.lastHealthCheckAt
                  ? new Date(repository.lastHealthCheckAt).toLocaleString()
                  : 'Never'}
              </span>
            </div>
          </div>
        </div>

        {/* collapsed raw configMetadata when non-empty */}
        {repository.configMetadata && repository.configMetadata.trim() !== '' && (
          <details
            className="mt-4 border border-slate-800 bg-slate-950/50 rounded-md p-3 cursor-pointer"
            data-testid="raw-config-details"
          >
            <summary className="text-xs font-semibold text-slate-400 hover:text-slate-200 select-none">
              Raw Configuration Metadata
            </summary>
            <pre className="mt-2 p-2 bg-slate-900 border border-slate-800 rounded font-mono text-xxs overflow-x-auto text-slate-300">
              {repository.configMetadata}
            </pre>
          </details>
        )}
      </div>

      {/* Metrics Section */}
      <StatusMetrics metrics={metrics} />

      {/* New Run Form */}
      <NewRunForm
        overviewRepository={repository}
        repositories={repositories}
        availabilityResults={availabilityResults}
      />

      {/* Runs Table Section */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-slate-200">Repository Runs</h2>

        <RunFilters
          repositories={repositories}
          currentRepositoryId={repositoryId}
          currentStatus={status}
        />

        <RunTable runs={runs} repositoryMap={repositoryMap} showRepository={false} />

        {totalPages > 1 && (
          <RunPagination
            page={page}
            totalPages={totalPages}
            currentRepositoryId={repositoryId}
            currentStatus={status}
          />
        )}
      </div>
    </main>
  );
}

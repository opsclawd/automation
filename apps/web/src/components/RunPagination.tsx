import Link from 'next/link';

interface RunPaginationProps {
  page: number;
  totalPages: number;
  currentRepositoryId?: string | undefined;
  currentStatus?: string | undefined;
  actionRoute: string;
}

export default function RunPagination({
  page,
  totalPages,
  currentRepositoryId = '',
  currentStatus = '',
  actionRoute,
}: RunPaginationProps) {
  const getPageUrl = (targetPage: number) => {
    const params = new URLSearchParams();
    if (currentRepositoryId) {
      params.set('repositoryId', currentRepositoryId);
    }
    if (currentStatus) {
      params.set('status', currentStatus);
    }
    params.set('page', String(targetPage));
    const qs = params.toString();
    return `${actionRoute}${qs ? `?${qs}` : ''}`;
  };

  return (
    <nav className="flex items-center justify-between mt-4 text-sm" aria-label="Pagination">
      <span className="text-slate-600">
        Page {page} of {totalPages}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link
            href={getPageUrl(page - 1)}
            className="rounded border px-3 py-1.5 text-slate-700 hover:bg-slate-50"
          >
            Previous
          </Link>
        ) : (
          <span className="rounded border px-3 py-1.5 text-slate-300">Previous</span>
        )}
        {page < totalPages ? (
          <Link
            href={getPageUrl(page + 1)}
            className="rounded border px-3 py-1.5 text-slate-700 hover:bg-slate-50"
          >
            Next
          </Link>
        ) : (
          <span className="rounded border px-3 py-1.5 text-slate-300">Next</span>
        )}
      </div>
    </nav>
  );
}

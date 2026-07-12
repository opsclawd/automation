import { RepositoryDto } from '@/lib/api-client';
import { getRepositoryAvailability } from '@/lib/repository-availability';

interface RepositoryAvailabilityBadgeProps {
  repository: RepositoryDto;
}

export default function RepositoryAvailabilityBadge({
  repository,
}: RepositoryAvailabilityBadgeProps) {
  const availability = getRepositoryAvailability(repository);

  let bgClass = 'bg-slate-700 text-slate-300 border-slate-600';
  if (availability.eligible) {
    bgClass = 'bg-emerald-950 text-emerald-300 border-emerald-800';
  } else if (!repository.enabled) {
    bgClass = 'bg-slate-800 text-slate-400 border-slate-700';
  } else {
    bgClass = 'bg-rose-950 text-rose-300 border-rose-800';
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-slate-400">Availability:</span>
        <span
          data-testid="availability-badge"
          className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-semibold ${bgClass}`}
        >
          {availability.label}
        </span>
      </div>
      {availability.reason && (
        <p data-testid="availability-reason" className="text-xs text-rose-400 mt-1">
          {availability.reason}
        </p>
      )}
    </div>
  );
}

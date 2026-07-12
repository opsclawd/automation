import { RUN_STATUSES } from '@/lib/api-client';

interface StatusMetricsProps {
  metrics: Record<string, number>;
}

export default function StatusMetrics({ metrics }: StatusMetricsProps) {
  const total = Object.values(metrics).reduce((sum, count) => sum + count, 0);

  const formatLabel = (status: string) => {
    return status
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'passed':
        return 'text-emerald-400 bg-emerald-950/40 border-emerald-800/60';
      case 'failed':
        return 'text-rose-400 bg-rose-950/40 border-rose-800/60';
      case 'running':
        return 'text-blue-400 bg-blue-950/40 border-blue-800/60';
      case 'waiting':
        return 'text-amber-400 bg-amber-950/40 border-amber-800/60';
      case 'needs_human_review':
        return 'text-purple-400 bg-purple-950/40 border-purple-800/60';
      default:
        return 'text-slate-400 bg-slate-800/40 border-slate-700/60';
    }
  };

  return (
    <div
      className="bg-slate-900 border border-slate-800 rounded-lg p-4 shadow-sm"
      data-testid="status-metrics"
    >
      <h3 className="text-sm font-semibold text-slate-300 mb-3">Run Metrics</h3>
      <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-9 gap-3">
        {/* Total Runs Tile */}
        <div
          data-testid="metric-tile-total"
          className="flex flex-col items-center justify-center p-2 rounded border border-slate-700 bg-slate-800/60"
        >
          <span className="text-2xl font-bold text-white" data-testid="metric-count-total">
            {total}
          </span>
          <span className="text-xxs font-medium text-slate-400 mt-1">Total Runs</span>
        </div>

        {/* Individual Status Tiles */}
        {RUN_STATUSES.map((status) => {
          const count = metrics[status] ?? 0;
          return (
            <div
              key={status}
              data-testid={`metric-tile-${status}`}
              className={`flex flex-col items-center justify-center p-2 rounded border ${getStatusColor(status)}`}
            >
              <span className="text-xl font-bold" data-testid={`metric-count-${status}`}>
                {count}
              </span>
              <span className="text-xxs font-medium text-center leading-none mt-1 truncate w-full">
                {formatLabel(status)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

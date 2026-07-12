'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { refreshRepositoryHealth } from '@/lib/api-client';

interface RefreshRepositoryHealthButtonProps {
  repositoryId: string;
}

export default function RefreshRepositoryHealthButton({
  repositoryId,
}: RefreshRepositoryHealthButtonProps) {
  const router = useRouter();
  const [status, setStatus] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const handleRefresh = async () => {
    if (status === 'submitting') return;
    setStatus('submitting');
    setError(null);
    try {
      await refreshRepositoryHealth(repositoryId);
      setStatus('idle');
      router.refresh();
    } catch (e: unknown) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Failed to refresh health');
    }
  };

  return (
    <div className="flex flex-col gap-2 items-start">
      <button
        type="button"
        id="refresh-health-btn"
        data-testid="refresh-health-btn"
        onClick={handleRefresh}
        disabled={status === 'submitting'}
        className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-500 text-slate-200 border border-slate-600 rounded text-xs font-semibold transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed"
      >
        {status === 'submitting' ? 'Refreshing...' : 'Refresh Health'}
      </button>
      {error && (
        <p
          id="health-refresh-error"
          data-testid="health-refresh-error"
          className="text-xs text-rose-400"
        >
          {error}
        </p>
      )}
    </div>
  );
}

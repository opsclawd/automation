'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RepositoryDto, startRun, repositoryRunHref } from '@/lib/api-client';
import { AvailabilityResult } from '@/lib/repository-availability';

interface NewRunFormProps {
  overviewRepository: RepositoryDto;
  repositories: RepositoryDto[];
  availabilityResults: Record<string, AvailabilityResult>;
}

export default function NewRunForm({
  overviewRepository,
  repositories,
  availabilityResults,
}: NewRunFormProps) {
  const router = useRouter();

  const enabledRepos = repositories.filter((r) => r.enabled);
  const hasMultipleEnabled = enabledRepos.length >= 2;
  const isOverviewEligible = availabilityResults[overviewRepository.id]?.eligible;

  // Preselect the overview Repository only if eligible, and only if there are not multiple enabled repositories.
  const initialRepoId = !hasMultipleEnabled && isOverviewEligible ? overviewRepository.id : '';

  const [issueNumber, setIssueNumber] = useState<string>('');
  const [selectedRepoId, setSelectedRepoId] = useState<string>(initialRepoId);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const eligibleRepos = repositories.filter((r) => availabilityResults[r.id]?.eligible);
  const hasEligible = eligibleRepos.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (status === 'submitting') return;

    const num = parseInt(issueNumber, 10);
    if (isNaN(num) || num <= 0 || num.toString() !== issueNumber.trim()) {
      setError('Issue number must be a positive integer.');
      setStatus('error');
      return;
    }

    if (!selectedRepoId) {
      setError('Please select a repository.');
      setStatus('error');
      return;
    }

    const avail = availabilityResults[selectedRepoId];
    if (!avail || !avail.eligible) {
      setError('Selected repository is not eligible.');
      setStatus('error');
      return;
    }

    setStatus('submitting');
    setError(null);

    try {
      const response = await startRun(selectedRepoId, num);
      router.push(repositoryRunHref(response.run.repoId, response.run.uuid));
      router.refresh();
    } catch (err: unknown) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Failed to start run');
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-slate-900 border border-slate-800 rounded-lg p-6 shadow-sm flex flex-col gap-4"
      data-testid="new-run-form"
    >
      <h3 className="text-base font-semibold text-slate-200">Start New Run</h3>

      {!hasEligible && (
        <div
          data-testid="no-eligible-repos-explanation"
          className="p-3 rounded bg-amber-950/40 border border-amber-800 text-amber-300 text-xs"
        >
          No eligible repositories available. There must be at least one healthy, enabled repository
          to start a run.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Issue Number Input */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="run-issue-number" className="text-xs font-semibold text-slate-400">
            Issue Number (Positive Integer)
          </label>
          <input
            id="run-issue-number"
            data-testid="run-issue-number"
            type="number"
            min="1"
            step="1"
            value={issueNumber}
            onChange={(e) => setIssueNumber(e.target.value)}
            disabled={status === 'submitting' || !hasEligible}
            placeholder="e.g. 42"
            className="bg-slate-800 border border-slate-700 text-white rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
          />
        </div>

        {/* Repository Select */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="run-repository-id" className="text-xs font-semibold text-slate-400">
            Repository
          </label>
          <select
            id="run-repository-id"
            data-testid="run-repository-id"
            value={selectedRepoId}
            onChange={(e) => setSelectedRepoId(e.target.value)}
            disabled={status === 'submitting' || !hasEligible}
            className="bg-slate-800 border border-slate-700 text-white rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
          >
            <option value="">-- Select Repository --</option>
            {repositories.map((repo) => {
              const avail = availabilityResults[repo.id];
              const isEligible = avail?.eligible;
              const reasonSuffix = avail?.reason ? ` (${avail.reason})` : '';

              return (
                <option
                  key={repo.id}
                  value={repo.id}
                  disabled={!isEligible}
                  className={!isEligible ? 'text-slate-500' : 'text-white'}
                >
                  {repo.fullName}
                  {!isEligible ? ` [Ineligible${reasonSuffix}]` : ''}
                </option>
              );
            })}
          </select>
        </div>
      </div>

      {error && (
        <div
          data-testid="new-run-error"
          className="p-3 rounded bg-rose-950/40 border border-rose-800 text-rose-300 text-xs"
        >
          {error}
        </div>
      )}

      <button
        type="submit"
        data-testid="new-run-submit"
        disabled={status === 'submitting' || !hasEligible}
        className="w-full md:w-auto self-end px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800/50 disabled:text-slate-500 text-white font-semibold rounded text-sm transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed"
      >
        {status === 'submitting' ? 'Starting Run...' : 'Start Run'}
      </button>
    </form>
  );
}

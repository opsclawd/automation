'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  RunDto,
  cancelRunAction,
  retryRunAction,
  resumeRunAction,
  RunActionConfirmationRequiredError,
  type ConfirmationRequiredDto,
} from '@/lib/api-client';

const CANONICAL_PHASE_ORDER = [
  'read_issue',
  'plan-design',
  'plan-write',
  'implement',
  'validate',
  'fix-validate',
  'review-fix',
  'compound',
  'create-pr',
  'post-pr-review',
];

interface RunActionsProps {
  run: RunDto;
}

export function RunActions({ run }: RunActionsProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [selectedPhase, setSelectedPhase] = useState<string>('');
  const [showDialog, setShowDialog] = useState(false);
  const [dialogPayload, setDialogPayload] = useState<ConfirmationRequiredDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const showCancel =
    run.status !== 'passed' && run.status !== 'failed' && run.status !== 'cancelled';
  const showResumeRetry = run.status === 'failed';

  if (!showCancel && !showResumeRetry) {
    return null;
  }

  const handleCancel = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await cancelRunAction(run.uuid);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleResume = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const input: { fromPhase?: string; confirm?: boolean } = {};
      if (selectedPhase) {
        input.fromPhase = selectedPhase;
      }
      await resumeRunAction(run.uuid, input);
      router.refresh();
    } catch (err) {
      if (err instanceof RunActionConfirmationRequiredError) {
        setDialogPayload(err.payload);
        setShowDialog(true);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleRetry = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await retryRunAction(run.uuid);
      router.refresh();
    } catch (err) {
      if (err instanceof RunActionConfirmationRequiredError) {
        setDialogPayload(err.payload);
        setShowDialog(true);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleCloseDialog = () => {
    setShowDialog(false);
    setDialogPayload(null);
  };

  const handleConfirm = async () => {
    if (!dialogPayload) return;
    setIsLoading(true);
    setShowDialog(false);
    try {
      if (dialogPayload.action === 'retry') {
        await retryRunAction(run.uuid, true);
      } else if (dialogPayload.action === 'resume') {
        const input: { fromPhase?: string; confirm?: boolean } = { confirm: true };
        if (dialogPayload.targetPhase) {
          input.fromPhase = dialogPayload.targetPhase;
        }
        await resumeRunAction(run.uuid, input);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-1 items-start">
      <div className="flex items-center gap-2">
        {showCancel && (
          <button
            type="button"
            onClick={handleCancel}
            disabled={isLoading}
            className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:bg-slate-300 transition-colors animate-fade-in"
          >
            Cancel
          </button>
        )}

        {showResumeRetry && (
          <>
            <select
              value={selectedPhase}
              onChange={(e) => setSelectedPhase(e.target.value)}
              disabled={isLoading}
              className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800 focus:border-blue-500 focus:outline-none disabled:bg-slate-50 transition-colors"
            >
              <option value="">Automatic (failed step)</option>
              {CANONICAL_PHASE_ORDER.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleResume}
              disabled={isLoading}
              className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:bg-slate-300 transition-colors"
            >
              Resume
            </button>
            <button
              type="button"
              onClick={handleRetry}
              disabled={isLoading}
              className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 transition-colors"
            >
              Retry phase
            </button>
          </>
        )}
      </div>

      {error && <div className="text-xs text-red-600 font-medium mt-1">{error}</div>}

      {showDialog && dialogPayload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl border border-slate-200">
            <h2 className="text-base font-semibold text-slate-900 mb-2">Confirmation Required</h2>
            <p className="text-sm text-slate-600 mb-4">{dialogPayload.message}</p>
            {dialogPayload.targetPhase && (
              <div className="mb-4 text-xs bg-amber-50 text-amber-800 border border-amber-200 rounded p-2">
                <b>Target Phase:</b> {dialogPayload.targetPhase}
              </div>
            )}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseDialog}
                className="rounded border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                className="rounded bg-amber-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-amber-700 transition-colors"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

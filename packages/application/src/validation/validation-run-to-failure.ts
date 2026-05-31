import { validationRunPassed, type Failure, type ValidationRun } from '@ai-sdlc/domain';

/**
 * Build a run-level Failure from a ValidationRun. Returns null when the run
 * passed. Uses 'validation_failed' when any command failed; 'timeout' only when
 * the sole failures are timeouts. Validation is deterministic, so canRetry=true.
 */
export function validationRunToFailure(run: ValidationRun, detectedAt: Date): Failure | null {
  if (validationRunPassed(run)) return null;

  const failed = run.commands.filter((c) => c.outcome === 'failed');
  const timedOut = run.commands.filter((c) => c.outcome === 'timed_out');
  const bad = [...failed, ...timedOut];
  if (bad.length === 0) return null;

  const kind: Failure['kind'] = failed.length > 0 ? 'validation_failed' : 'timeout';

  const parts = bad.map((c) => {
    const label = c.kind ?? 'other';
    const detail =
      c.outcome === 'timed_out'
        ? 'timed out'
        : c.classifier
          ? c.classifier.split('\n').slice(-1)[0]
          : `exit ${c.exitCode}`;
    return `${label} (${detail})`;
  });
  const message = `${bad.length} validation command(s) failed: ${parts.join(', ')}. See validate/ logs.`;

  const artifacts = [
    ...bad.flatMap((c) => [c.stdoutPath, c.stderrPath]).filter(Boolean),
    'validation-result.json',
  ];

  return {
    runUuid: run.runId,
    phase: run.phaseId,
    kind,
    message,
    canRetry: true,
    suggestedAction: 'Open the validate phase logs and rerun the failing command(s) locally.',
    artifacts,
    detectedAt,
  };
}

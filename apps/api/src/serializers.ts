import type { RunRecord } from '@ai-sdlc/infrastructure';
import type { FailureRepository } from '@ai-sdlc/infrastructure';

export function serializeRun(r: RunRecord) {
  return {
    uuid: r.uuid,
    displayId: r.displayId,
    issueNumber: r.issueNumber,
    status: r.status,
    currentPhase: r.currentPhase !== undefined ? r.currentPhase : null,
    completedPhases: r.completedPhases,
    startedAt: r.startedAt.toISOString(),
    completedAt: r.completedAt !== undefined ? r.completedAt.toISOString() : null,
    exitCode: r.exitCode !== undefined ? r.exitCode : null,
    durationMs: r.durationMs !== undefined ? r.durationMs : null,
    failureReason: r.failureReason !== undefined ? r.failureReason : null,
  };
}

export function serializeFailure(f: NonNullable<ReturnType<FailureRepository['findLatestByRun']>>) {
  return {
    kind: f.kind,
    message: f.message,
    ...(f.phase !== undefined ? { phase: f.phase } : {}),
    ...(f.exitCode !== undefined ? { exitCode: f.exitCode } : {}),
    suggestedAction: f.suggestedAction,
    artifacts: f.artifacts,
  };
}

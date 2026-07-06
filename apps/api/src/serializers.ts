import type { Container } from './compose.js';
import type { Job } from '@ai-sdlc/domain';

type RunItem = ReturnType<Container['runRepository']['list']>['runs'][number];
type FailureItem = NonNullable<ReturnType<Container['failureRepository']['findLatestByRun']>>;
type EventItem = ReturnType<Container['eventRepository']['listByRunSince']>[number];

export function serializeRun(r: RunItem) {
  return {
    uuid: r.uuid,
    displayId: r.displayId,
    issueNumber: r.issueNumber,
    status: r.status,
    currentPhase: r.currentPhase !== undefined ? r.currentPhase : null,
    completedPhases: r.completedPhases,
    repoId: r.repoId,
    startedAt: r.startedAt.toISOString(),
    completedAt: r.completedAt !== undefined ? r.completedAt.toISOString() : null,
    exitCode: r.exitCode !== undefined ? r.exitCode : null,
    durationMs: r.durationMs !== undefined ? r.durationMs : null,
    failureReason: r.failureReason !== undefined ? r.failureReason : null,
  };
}

export function serializeEvent(e: EventItem, displayId: string) {
  return {
    id: e.id,
    runId: displayId,
    phase: e.phase ?? null,
    level: e.level,
    type: e.type,
    message: e.message,
    timestamp: e.timestamp.toISOString(),
    metadata: e.metadata,
  };
}

export function serializeFailure(f: FailureItem) {
  return {
    kind: f.kind,
    message: f.message,
    ...(f.phase !== undefined ? { phase: f.phase } : {}),
    ...(f.exitCode !== undefined ? { exitCode: f.exitCode } : {}),
    suggestedAction: f.suggestedAction,
    artifacts: f.artifacts,
  };
}

export function serializeJob(job: Job) {
  return {
    id: job.id,
    status: job.status,
    runId: job.runId,
    repoId: job.repoId,
    issueNumber: job.issueNumber,
    attempts: job.attempts,
    createdAt: job.createdAt.toISOString(),
    claimedAt: job.claimedAt?.toISOString() ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

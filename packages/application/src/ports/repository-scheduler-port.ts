import type { Repository, RepositoryId } from '@ai-sdlc/domain';

export type RepositoryWorkInspection =
  | { available: true; queueDepth: number; activeCount: number }
  | { available: false; reason: 'disabled' | 'unhealthy' | 'unavailable'; detail: string };

export interface RepositoryWorkSourcePort {
  inspect(repository: Repository): Promise<RepositoryWorkInspection>;
}

export interface RepositoryDispatchPort {
  runOne(input: {
    repository: Repository;
    workerId: WorkerId;
    signal?: AbortSignal;
  }): Promise<'completed' | 'no_work'>;
}

export type WorkerId = import('@ai-sdlc/domain').WorkerId;

export type SchedulerDispatchStartedRecord = {
  type: 'scheduler.dispatch.started';
  repository_id: RepositoryId;
  repository_name: string;
  worker_id: WorkerId;
};

export type SchedulerDispatchCompletedRecord = {
  type: 'scheduler.dispatch.completed';
  repository_id: RepositoryId;
  repository_name: string;
  worker_id: WorkerId;
};

export type SchedulerDispatchFailedRecord = {
  type: 'scheduler.dispatch.failed';
  repository_id: RepositoryId;
  repository_name: string;
  worker_id: WorkerId;
  error: string;
};

export type SchedulerRepositorySkippedDisabledRecord = {
  type: 'scheduler.repository.skipped';
  repository_id: RepositoryId;
  repository_name: string;
  reason: 'disabled';
};

export type SchedulerRepositorySkippedUnhealthyRecord = {
  type: 'scheduler.repository.skipped';
  repository_id: RepositoryId;
  repository_name: string;
  reason: 'unhealthy';
  detail: string;
};

export type SchedulerRepositorySkippedUnavailableRecord = {
  type: 'scheduler.repository.skipped';
  repository_id: RepositoryId;
  repository_name: string;
  reason: 'unavailable';
  detail: string;
};

export type SchedulerRepositorySkippedAtCapRecord = {
  type: 'scheduler.repository.skipped';
  repository_id: RepositoryId;
  repository_name: string;
  reason: 'at_cap';
};

export type SchedulerRepositorySkippedNoWorkRecord = {
  type: 'scheduler.repository.skipped';
  repository_id: RepositoryId;
  repository_name: string;
  reason: 'no_work';
};

export type SchedulerRepositorySkippedRecord =
  | SchedulerRepositorySkippedDisabledRecord
  | SchedulerRepositorySkippedUnhealthyRecord
  | SchedulerRepositorySkippedUnavailableRecord
  | SchedulerRepositorySkippedAtCapRecord
  | SchedulerRepositorySkippedNoWorkRecord;

export type SchedulerTickFailedRecord = {
  type: 'scheduler.tick.failed';
  error: string;
};

export type SchedulerPoolActiveRecord = {
  type: 'scheduler.pool.active';
  count: number;
};

export type SchedulerRepositoryActiveRecord = {
  type: 'scheduler.repository.active';
  repository_id: RepositoryId;
  repository_name: string;
  count: number;
};

export type SchedulerRepositoryQueueDepthRecord = {
  type: 'scheduler.repository.queue_depth';
  repository_id: RepositoryId;
  repository_name: string;
  depth: number;
};

export type SchedulerDispatchTotalRecord = {
  type: 'scheduler.dispatch.total';
  count: number;
};

export type SchedulerRepositorySkipTotalRecord = {
  type: 'scheduler.repository.skip.total';
  count: number;
};

export type SchedulerTelemetryRecord =
  | SchedulerDispatchStartedRecord
  | SchedulerDispatchCompletedRecord
  | SchedulerDispatchFailedRecord
  | SchedulerRepositorySkippedRecord
  | SchedulerTickFailedRecord
  | SchedulerPoolActiveRecord
  | SchedulerRepositoryActiveRecord
  | SchedulerRepositoryQueueDepthRecord
  | SchedulerDispatchTotalRecord
  | SchedulerRepositorySkipTotalRecord;

export interface SchedulerTelemetryPort {
  record(record: SchedulerTelemetryRecord): void | Promise<void>;
}

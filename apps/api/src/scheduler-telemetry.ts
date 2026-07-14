import type {
  SchedulerTelemetryRecord,
  SchedulerTelemetryPort,
  LoggerPort,
} from '@ai-sdlc/application/ports';
import type { RepositoryId } from '@ai-sdlc/domain';

export class DefaultSchedulerTelemetry implements SchedulerTelemetryPort {
  private readonly logger: LoggerPort;
  private poolActive = 0;
  private dispatchTotal = 0;
  private repositorySkipTotal = 0;
  private repositoryActive = new Map<RepositoryId, number>();
  private repositoryQueueDepth = new Map<RepositoryId, number>();
  private lastUnavailableWarning = new Map<string, { reason: string; detail: string }>();

  constructor(deps: { logger: LoggerPort }) {
    this.logger = deps.logger;
  }

  record(r: SchedulerTelemetryRecord): void | Promise<void> {
    const suppressed = this.apply(r);
    if (!suppressed) {
      this.log(r);
    }
  }

  private apply(r: SchedulerTelemetryRecord): boolean {
    switch (r.type) {
      case 'scheduler.pool.active':
        this.poolActive = r.count;
        return false;
      case 'scheduler.dispatch.total':
        this.dispatchTotal = r.count;
        return false;
      case 'scheduler.repository.skip.total':
        this.repositorySkipTotal = r.count;
        return false;
      case 'scheduler.repository.active':
        this.repositoryActive.set(r.repository_id, r.count);
        return false;
      case 'scheduler.repository.queue_depth':
        this.repositoryQueueDepth.set(r.repository_id, r.depth);
        this.lastUnavailableWarning.delete(String(r.repository_id));
        return false;
      case 'scheduler.repository.skipped':
        if (r.reason === 'unavailable' || r.reason === 'unhealthy') {
          const key = String(r.repository_id);
          const last = this.lastUnavailableWarning.get(key);
          if (last && last.reason === r.reason && last.detail === r.detail) {
            return true;
          }
          this.lastUnavailableWarning.set(key, { reason: r.reason, detail: r.detail });
        }
        this.repositorySkipTotal++;
        return false;
      case 'scheduler.dispatch.started':
        this.lastUnavailableWarning.delete(String(r.repository_id));
        return false;
      case 'scheduler.dispatch.completed':
        return false;
      case 'scheduler.dispatch.failed':
        return false;
      case 'scheduler.tick.failed':
        return false;
      default:
        return false;
    }
  }

  private log(r: SchedulerTelemetryRecord): void {
    if (r.type === 'scheduler.repository.skipped') {
      this.logger.warn('scheduler.telemetry', { record: r });
    } else {
      this.logger.info('scheduler.telemetry', { record: r });
    }
  }

  getPoolActive(): number {
    return this.poolActive;
  }

  getDispatchTotal(): number {
    return this.dispatchTotal;
  }

  getRepositorySkipTotal(): number {
    return this.repositorySkipTotal;
  }

  getRepositoryActive(repoId: RepositoryId): number {
    return this.repositoryActive.get(repoId) ?? 0;
  }

  getRepositoryQueueDepth(repoId: RepositoryId): number {
    return this.repositoryQueueDepth.get(repoId) ?? 0;
  }
}

import type { FairRepositoryScheduler } from '@ai-sdlc/application';
import type { WorkerId } from '@ai-sdlc/domain';

export interface ShutdownCoordinatorDeps {
  scheduler: FairRepositoryScheduler;
  runtimeCatalog: { close: () => Promise<void> };
  server?: { stop: () => Promise<void> };
  auxiliaryTimers:
    | Array<{ stop: () => void } | undefined | null>
    | (() => Array<{ stop: () => void } | undefined | null>);
  shutdownGraceMs: number;
}

export interface ShutdownResult {
  ok: boolean;
  remainingWorkerIds?: WorkerId[];
}

export class ShutdownCoordinator {
  private readonly deps: ShutdownCoordinatorDeps;
  private shutdownPromise: Promise<ShutdownResult> | null = null;
  private signalHandlers: Array<() => void> = [];

  constructor(deps: ShutdownCoordinatorDeps) {
    this.deps = deps;
  }

  async shutdown(signal: AbortSignal): Promise<ShutdownResult> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = this.executeShutdown(signal);
    return this.shutdownPromise;
  }

  private async executeShutdown(_signal: AbortSignal): Promise<ShutdownResult> {
    this.deps.scheduler.stopAdmission('shutdown');

    const drainResult = await this.deps.scheduler.drain(this.deps.shutdownGraceMs);

    if (!drainResult.drained) {
      console.error(
        `drain timed out, ${drainResult.remainingWorkerIds.length} workers still active: ${drainResult.remainingWorkerIds.join(', ')}`,
      );
    }

    await this.closeResources();

    return { ok: drainResult.drained, remainingWorkerIds: drainResult.remainingWorkerIds };
  }

  private async closeResources(): Promise<void> {
    try {
      await this.deps.runtimeCatalog.close();
    } finally {
      const timers =
        typeof this.deps.auxiliaryTimers === 'function'
          ? this.deps.auxiliaryTimers()
          : this.deps.auxiliaryTimers;
      (timers as Array<{ stop: () => void } | undefined | null>).forEach((timer) => timer?.stop());
      if (this.deps.server) {
        await this.deps.server.stop();
      }
    }
  }

  registerSignalHandlers(): void {
    const sigintHandler = () => {
      const controller = new AbortController();
      this.shutdown(controller.signal);
    };
    const sigtermHandler = () => {
      const controller = new AbortController();
      this.shutdown(controller.signal);
    };

    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigtermHandler);

    this.signalHandlers = [
      () => process.off('SIGINT', sigintHandler),
      () => process.off('SIGTERM', sigtermHandler),
    ];
  }

  unregisterSignalHandlers(): void {
    this.signalHandlers.forEach((unregister) => unregister());
    this.signalHandlers = [];
  }
}

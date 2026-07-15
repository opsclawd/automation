import type { RepositoryId } from '@ai-sdlc/domain';
import type { Repository } from '@ai-sdlc/domain';
import type {
  JobQueuePort,
  WorkerLeasePort,
  WorkerRegistryPort,
  RunRepositoryPort,
  RunRepositoryUpdatePatch,
  PrReviewRepositoryPort,
  LoopRepositoryPort,
  AgentInvocationPort,
  ValidationRunRepositoryPort,
} from '@ai-sdlc/application/ports';
import type { EventRepositoryPort, FailureRepositoryPort } from '@ai-sdlc/application';
import { RepositoryRuntimePaths } from './repository-runtime-paths.js';
import type { LoadedConfig } from '@ai-sdlc/shared';

export class RepositoryResolutionError extends Error {
  readonly repositoryId: RepositoryId;
  readonly reason: 'disabled' | 'degraded' | 'unreachable' | 'unknown' | 'migration_ambiguous';
  constructor(
    repositoryId: RepositoryId,
    reason: RepositoryResolutionError['reason'],
    message: string,
  ) {
    super(message);
    this.name = 'RepositoryResolutionError';
    this.repositoryId = repositoryId;
    this.reason = reason;
  }
}

export interface RepositoryRuntimeLoopDeps {
  registry: WorkerRegistryPort;
  queue: JobQueuePort;
  leases: WorkerLeasePort;
  repos: {
    findById: (id: RepositoryId) => Repository | undefined;
    findByFullName: (fullName: string) => Repository | undefined;
    findByLocalPath: (localBasePath: string) => Repository | undefined;
    listAll: () => Array<Repository>;
    listEnabled: () => Array<Repository>;
  };
  repoId: RepositoryId;
  updateRun(runId: import('@ai-sdlc/domain').RunId, patch: RunRepositoryUpdatePatch): void;
}

export interface RepositoryOperationalRuntime {
  readonly repository: Repository;
  readonly paths: RepositoryRuntimePaths;
  readonly runRepository: RunRepositoryPort;
  readonly workerRegistry: WorkerRegistryPort;
  readonly workerLeaseRepository: WorkerLeasePort;
  readonly workerLoopDeps: RepositoryRuntimeLoopDeps;
  readonly eventRepository: EventRepositoryPort;
  readonly prReviewRepository: PrReviewRepositoryPort;
  readonly loopRepository: LoopRepositoryPort;
  readonly agentInvocationRepository: AgentInvocationPort;
  readonly validationRunRepository: ValidationRunRepositoryPort;
  readonly failureRepository: FailureRepositoryPort;
  readonly jobQueue: JobQueuePort;
  close(): void;
}

export interface RepositoryExecutionRuntime extends RepositoryOperationalRuntime {
  readonly configFingerprint: string;
  readonly defaultBranch: string;
  readonly fullName: string;
}

export type RepositoryRuntime = RepositoryExecutionRuntime;

interface OperationalCacheEntry {
  runtime: RepositoryOperationalRuntime;
  isStale: boolean;
  markedStaleAt?: Date;
  buildPromise?: Promise<RepositoryOperationalRuntime>;
}

interface ExecutionCacheEntry {
  runtime: RepositoryExecutionRuntime;
  fingerprint: string;
  isStale: boolean;
  markedStaleAt?: Date;
  buildPromise?: Promise<RepositoryExecutionRuntime>;
}

export interface RepositoryRuntimeFactoryOptions {
  stateRoot: string;
  now?: () => Date;
  buildOperationalRuntime: (input: {
    repository: Repository;
    paths: RepositoryRuntimePaths;
  }) => Promise<RepositoryOperationalRuntime>;
  buildExecutionRuntime: (input: {
    repository: Repository;
    paths: RepositoryRuntimePaths;
    loadedConfig: LoadedConfig;
  }) => Promise<RepositoryExecutionRuntime>;
}

export class RepositoryRuntimeFactory {
  private static readonly MAX_STALE_AGE_MS = 10 * 60 * 1000;

  private readonly operationalCache = new Map<string, OperationalCacheEntry>();
  private readonly executionCache = new Map<string, ExecutionCacheEntry>();
  private readonly staleOperationalRuntimes = new Set<string>();
  private readonly staleExecutionRuntimes = new Set<string>();
  private readonly activeFingerprint = new Map<string, string>();
  private reapScheduled = false;
  private reapTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: RepositoryRuntimeFactoryOptions;

  constructor(opts: RepositoryRuntimeFactoryOptions) {
    this.opts = opts;
  }

  private operationalCacheKey(repoId: RepositoryId): string {
    return String(repoId);
  }

  private executionCacheKey(repoId: RepositoryId, fingerprint: string): string {
    return `${String(repoId)}|${fingerprint}`;
  }

  private markStale(key: string, isOperational: boolean): void {
    const cache = isOperational ? this.operationalCache : this.executionCache;
    const staleSet = isOperational ? this.staleOperationalRuntimes : this.staleExecutionRuntimes;
    const entry = cache.get(key);
    if (entry) {
      entry.isStale = true;
      const now = this.opts.now?.();
      entry.markedStaleAt = now ?? new Date();
      staleSet.add(key);
      this.scheduleReap();
    }
  }

  private unmarkStale(key: string, isOperational: boolean): void {
    const cache = isOperational ? this.operationalCache : this.executionCache;
    const staleSet = isOperational ? this.staleOperationalRuntimes : this.staleExecutionRuntimes;
    const entry = cache.get(key);
    if (entry) {
      entry.isStale = false;
      delete entry.markedStaleAt;
      staleSet.delete(key);
    }
  }

  private scheduleReap(): void {
    if (this.reapScheduled) return;
    this.reapScheduled = true;
    this.reapTimer = setTimeout(() => {
      this.reapScheduled = false;
      this.reapTimer = null;
      this.reapStaleRuntimes();
    }, 5000);
  }

  private reapStaleRuntimes(): void {
    const now = this.opts.now?.() ?? new Date();
    let needsRetry = false;

    const reapOperationalEntry = (
      cache: Map<string, OperationalCacheEntry>,
      staleSet: Set<string>,
    ) => {
      for (const key of staleSet) {
        const entry = cache.get(key);
        if (!entry) {
          staleSet.delete(key);
          continue;
        }

        if (entry.buildPromise) {
          needsRetry = true;
          continue;
        }

        const staleAgeMs = entry.markedStaleAt ? now.getTime() - entry.markedStaleAt.getTime() : 0;
        const exceededMaxAge = staleAgeMs >= RepositoryRuntimeFactory.MAX_STALE_AGE_MS;

        let hasActiveLease: boolean;
        try {
          hasActiveLease = entry.runtime.workerLeaseRepository.checkActiveLease(
            entry.runtime.repository.id,
            now,
          );
        } catch {
          hasActiveLease = true;
          needsRetry = true;
        }

        if (hasActiveLease && !exceededMaxAge) {
          needsRetry = true;
          continue;
        }

        try {
          entry.runtime.close();
        } catch {
          // Best-effort: eviction must not throw
        }
        cache.delete(key);
        staleSet.delete(key);
      }
    };

    const reapExecutionEntry = (cache: Map<string, ExecutionCacheEntry>, staleSet: Set<string>) => {
      for (const key of staleSet) {
        const entry = cache.get(key);
        if (!entry) {
          staleSet.delete(key);
          continue;
        }

        if (entry.buildPromise) {
          needsRetry = true;
          continue;
        }

        const repoIdStr = String(entry.runtime.repository.id);
        const activeFp = this.activeFingerprint.get(repoIdStr);
        const isActiveFingerprint = activeFp ? entry.fingerprint === activeFp : true;
        const staleAgeMs = entry.markedStaleAt ? now.getTime() - entry.markedStaleAt.getTime() : 0;
        const exceededMaxAge = staleAgeMs >= RepositoryRuntimeFactory.MAX_STALE_AGE_MS;

        let hasActiveLease: boolean;
        try {
          hasActiveLease = entry.runtime.workerLeaseRepository.checkActiveLease(
            entry.runtime.repository.id,
            now,
          );
        } catch {
          hasActiveLease = true;
          needsRetry = true;
        }

        if (hasActiveLease && isActiveFingerprint) {
          this.unmarkStale(key, false);
          continue;
        }

        if (hasActiveLease && !exceededMaxAge) {
          needsRetry = true;
          continue;
        }

        try {
          entry.runtime.close();
        } catch {
          // Best-effort: eviction must not throw
        }
        cache.delete(key);
        staleSet.delete(key);

        if (this.activeFingerprint.get(repoIdStr) === entry.fingerprint) {
          this.activeFingerprint.delete(repoIdStr);
        }
      }
    };

    reapOperationalEntry(this.operationalCache, this.staleOperationalRuntimes);
    reapExecutionEntry(this.executionCache, this.staleExecutionRuntimes);

    if (needsRetry) {
      this.scheduleReap();
    }
  }

  async getOperationalRuntime(repo: Repository): Promise<RepositoryOperationalRuntime> {
    const key = this.operationalCacheKey(repo.id);
    const existingEntry = this.operationalCache.get(key);

    if (existingEntry) {
      if (existingEntry.buildPromise) {
        return existingEntry.buildPromise;
      }
      this.unmarkStale(key, true);
      return existingEntry.runtime;
    }

    const paths = RepositoryRuntimePaths.create({
      stateRoot: this.opts.stateRoot,
      repository: repo,
    });

    const buildPromise = this.opts.buildOperationalRuntime({
      repository: repo,
      paths,
    });

    const placeholderEntry: OperationalCacheEntry = {
      runtime: null as unknown as RepositoryOperationalRuntime,
      isStale: false,
      buildPromise,
    };

    this.operationalCache.set(key, placeholderEntry);

    try {
      const runtime = await buildPromise;
      placeholderEntry.runtime = runtime;
      delete placeholderEntry.buildPromise;
      return runtime;
    } catch (err) {
      this.operationalCache.delete(key);
      throw err;
    }
  }

  async getRuntime(
    repo: Repository,
    loadedConfig: LoadedConfig,
    options?: { allowDisabled?: boolean },
  ): Promise<RepositoryExecutionRuntime> {
    if (!options?.allowDisabled && !repo.enabled) {
      throw new RepositoryResolutionError(
        repo.id,
        'disabled',
        `Repository ${repo.fullName} is disabled`,
      );
    }
    if (repo.healthStatus === 'degraded') {
      throw new RepositoryResolutionError(
        repo.id,
        'degraded',
        `Repository ${repo.fullName} is in degraded health state: ${repo.healthError ?? 'unknown'}`,
      );
    }
    if (repo.healthStatus === 'unreachable') {
      throw new RepositoryResolutionError(
        repo.id,
        'unreachable',
        `Repository ${repo.fullName} is unreachable: ${repo.healthError ?? 'unknown'}`,
      );
    }
    if (repo.healthStatus === 'unknown') {
      throw new RepositoryResolutionError(
        repo.id,
        'unknown',
        `Repository ${repo.fullName} has unknown health status: ${repo.healthError ?? 'unknown'}`,
      );
    }

    const key = this.executionCacheKey(repo.id, loadedConfig.fingerprint);
    const existingEntry = this.executionCache.get(key);

    if (existingEntry) {
      if (existingEntry.buildPromise) {
        return existingEntry.buildPromise;
      }
      const previousActiveFingerprint = this.activeFingerprint.get(String(repo.id));
      if (previousActiveFingerprint && previousActiveFingerprint !== loadedConfig.fingerprint) {
        const previousKey = this.executionCacheKey(repo.id, previousActiveFingerprint);
        this.markStale(previousKey, false);
      }
      this.activeFingerprint.set(String(repo.id), loadedConfig.fingerprint);
      this.unmarkStale(key, false);
      return existingEntry.runtime;
    }

    const previousActiveFingerprint = this.activeFingerprint.get(String(repo.id));
    if (previousActiveFingerprint && previousActiveFingerprint !== loadedConfig.fingerprint) {
      const previousKey = this.executionCacheKey(repo.id, previousActiveFingerprint);
      this.markStale(previousKey, false);
    }

    this.activeFingerprint.set(String(repo.id), loadedConfig.fingerprint);

    const paths = RepositoryRuntimePaths.create({
      stateRoot: this.opts.stateRoot,
      repository: repo,
    });

    const buildPromise = this.opts.buildExecutionRuntime({
      repository: repo,
      paths,
      loadedConfig,
    });

    const placeholderEntry: ExecutionCacheEntry = {
      runtime: null as unknown as RepositoryExecutionRuntime,
      fingerprint: loadedConfig.fingerprint,
      isStale: false,
      buildPromise,
    };

    this.executionCache.set(key, placeholderEntry);

    try {
      const runtime = await buildPromise;
      placeholderEntry.runtime = runtime;
      delete placeholderEntry.buildPromise;
      return runtime;
    } catch (err) {
      this.executionCache.delete(key);
      if (this.activeFingerprint.get(String(repo.id)) === loadedConfig.fingerprint) {
        this.activeFingerprint.delete(String(repo.id));
      }
      throw err;
    }
  }

  onLeaseReleased(repoId: RepositoryId): void {
    const now = this.opts.now?.() ?? new Date();
    const repoIdStr = String(repoId);
    const activeFp = this.activeFingerprint.get(repoIdStr);

    if (activeFp) {
      const activeKey = this.executionCacheKey(repoId, activeFp);
      const activeEntry = this.executionCache.get(activeKey);
      if (activeEntry && activeEntry.runtime) {
        let hasActiveLease: boolean;
        try {
          hasActiveLease = activeEntry.runtime.workerLeaseRepository.checkActiveLease(repoId, now);
        } catch {
          hasActiveLease = true;
        }

        if (hasActiveLease) {
          this.unmarkStale(activeKey, false);
        } else if (!activeEntry.isStale) {
          this.markStale(activeKey, false);
        }
      }
    }

    const operationalKey = this.operationalCacheKey(repoId);
    const operationalEntry = this.operationalCache.get(operationalKey);
    if (operationalEntry && operationalEntry.runtime) {
      let hasActiveLease: boolean;
      try {
        hasActiveLease = operationalEntry.runtime.workerLeaseRepository.checkActiveLease(
          repoId,
          now,
        );
      } catch {
        hasActiveLease = true;
      }

      if (hasActiveLease) {
        this.unmarkStale(operationalKey, true);
      } else if (!operationalEntry.isStale) {
        this.markStale(operationalKey, true);
      }
    }
  }

  onLeaseAcquired(repoId: RepositoryId): void {
    const activeFp = this.activeFingerprint.get(String(repoId));
    if (activeFp) {
      const key = this.executionCacheKey(repoId, activeFp);
      this.unmarkStale(key, false);
    }

    const operationalKey = this.operationalCacheKey(repoId);
    this.unmarkStale(operationalKey, true);
  }

  close(): void {
    if (this.reapTimer !== null) {
      clearTimeout(this.reapTimer);
      this.reapTimer = null;
    }
    for (const entry of this.operationalCache.values()) {
      if (entry.buildPromise) {
        entry.buildPromise.then((r) => r.close()).catch(() => {});
      }
      try {
        entry.runtime?.close();
      } catch {
        // Best-effort: shutdown must not throw
      }
    }
    for (const entry of this.executionCache.values()) {
      if (entry.buildPromise) {
        entry.buildPromise.then((r) => r.close()).catch(() => {});
      }
      try {
        entry.runtime?.close();
      } catch {
        // Best-effort: shutdown must not throw
      }
    }
    this.operationalCache.clear();
    this.executionCache.clear();
    this.staleOperationalRuntimes.clear();
    this.staleExecutionRuntimes.clear();
    this.activeFingerprint.clear();
  }

  getActiveRuntimes(): ReadonlyMap<string, RepositoryExecutionRuntime> {
    const result = new Map<string, RepositoryExecutionRuntime>();
    for (const [repoIdStr, activeFp] of this.activeFingerprint.entries()) {
      const key = this.executionCacheKey(repoIdStr as RepositoryId, activeFp);
      const entry = this.executionCache.get(key);
      if (entry && !entry.isStale && entry.runtime) {
        result.set(key, entry.runtime);
      }
    }
    return result;
  }

  isStale(repoId: RepositoryId): boolean {
    const repoIdStr = String(repoId);
    const activeFp = this.activeFingerprint.get(repoIdStr);
    if (!activeFp) return false;

    const key = this.executionCacheKey(repoId, activeFp);
    const entry = this.executionCache.get(key);
    return entry?.isStale ?? false;
  }
}

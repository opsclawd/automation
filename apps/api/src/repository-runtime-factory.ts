import type { RepositoryId } from '@ai-sdlc/domain';
import type { Repository } from '@ai-sdlc/domain';
import type {
  JobQueuePort,
  WorkerLeasePort,
  WorkerRegistryPort,
  RunRepositoryPort,
} from '@ai-sdlc/application/ports';
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
}

export interface RepositoryRuntime {
  readonly repository: Repository;
  readonly paths: RepositoryRuntimePaths;
  readonly configFingerprint: string;
  readonly defaultBranch: string;
  readonly fullName: string;
  readonly jobQueue: JobQueuePort;
  readonly runRepository: RunRepositoryPort;
  readonly workerRegistry: WorkerRegistryPort;
  readonly workerLeaseRepository: WorkerLeasePort;
  readonly workerLoopDeps: RepositoryRuntimeLoopDeps;
  close(): void;
}

interface CacheEntry {
  runtime: RepositoryRuntime;
  fingerprint: string;
  isStale: boolean;
  markedStaleAt?: Date;
  buildPromise?: Promise<RepositoryRuntime>;
}

export interface RepositoryRuntimeFactoryOptions {
  stateRoot: string;
  now?: () => Date;
  buildRuntime: (input: {
    repository: Repository;
    paths: RepositoryRuntimePaths;
    loadedConfig: LoadedConfig;
  }) => Promise<RepositoryRuntime>;
}

export class RepositoryRuntimeFactory {
  private static readonly MAX_STALE_AGE_MS = 10 * 60 * 1000;

  private readonly cache = new Map<string, CacheEntry>();
  private readonly staleRuntimes = new Set<string>();
  private readonly activeFingerprint = new Map<string, string>();
  private reapScheduled = false;
  private readonly opts: RepositoryRuntimeFactoryOptions;

  constructor(opts: RepositoryRuntimeFactoryOptions) {
    this.opts = opts;
  }

  private cacheKey(repoId: RepositoryId, fingerprint: string): string {
    return `${String(repoId)}|${fingerprint}`;
  }

  private markStale(key: string): void {
    const entry = this.cache.get(key);
    if (entry) {
      entry.isStale = true;
      const now = this.opts.now?.();
      entry.markedStaleAt = now ?? new Date();
      this.staleRuntimes.add(key);
      this.scheduleReap();
    }
  }

  private unmarkStale(key: string): void {
    const entry = this.cache.get(key);
    if (entry) {
      entry.isStale = false;
      delete entry.markedStaleAt;
      this.staleRuntimes.delete(key);
    }
  }

  private scheduleReap(): void {
    if (this.reapScheduled) return;
    this.reapScheduled = true;
    setImmediate(() => this.reapStaleRuntimes());
  }

  private reapStaleRuntimes(): void {
    this.reapScheduled = false;
    const now = this.opts.now?.() ?? new Date();
    let needsRetry = false;

    for (const key of this.staleRuntimes) {
      const entry = this.cache.get(key);
      if (!entry) {
        this.staleRuntimes.delete(key);
        continue;
      }

      if (entry.buildPromise) {
        needsRetry = true;
        continue;
      }

      const repoIdStr = String(entry.runtime.repository.id);
      const activeFp = this.activeFingerprint.get(repoIdStr);
      const isActiveFingerprint = entry.fingerprint === activeFp;
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
        this.unmarkStale(key);
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
      this.cache.delete(key);
      this.staleRuntimes.delete(key);

      if (this.activeFingerprint.get(repoIdStr) === entry.fingerprint) {
        this.activeFingerprint.delete(repoIdStr);
      }
    }

    if (needsRetry) {
      this.scheduleReap();
    }
  }

  private validateRepositoryState(repo: Repository): void {
    if (!repo.enabled) {
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
  }

  async getRuntime(repo: Repository, loadedConfig: LoadedConfig): Promise<RepositoryRuntime> {
    this.validateRepositoryState(repo);

    const key = this.cacheKey(repo.id, loadedConfig.fingerprint);
    const existingEntry = this.cache.get(key);

    if (existingEntry) {
      if (existingEntry.buildPromise) {
        return existingEntry.buildPromise;
      }
      const previousActiveFingerprint = this.activeFingerprint.get(String(repo.id));
      if (previousActiveFingerprint && previousActiveFingerprint !== loadedConfig.fingerprint) {
        const previousKey = this.cacheKey(repo.id, previousActiveFingerprint);
        this.markStale(previousKey);
      }
      this.activeFingerprint.set(String(repo.id), loadedConfig.fingerprint);
      this.unmarkStale(key);
      return existingEntry.runtime;
    }

    const previousActiveFingerprint = this.activeFingerprint.get(String(repo.id));
    if (previousActiveFingerprint && previousActiveFingerprint !== loadedConfig.fingerprint) {
      const previousKey = this.cacheKey(repo.id, previousActiveFingerprint);
      this.markStale(previousKey);
    }

    this.activeFingerprint.set(String(repo.id), loadedConfig.fingerprint);

    const paths = RepositoryRuntimePaths.create({
      stateRoot: this.opts.stateRoot,
      repository: repo,
    });

    const buildPromise = this.opts.buildRuntime({
      repository: repo,
      paths,
      loadedConfig,
    });

    const placeholderEntry: CacheEntry = {
      runtime: null as unknown as RepositoryRuntime,
      fingerprint: loadedConfig.fingerprint,
      isStale: false,
      buildPromise,
    };

    this.cache.set(key, placeholderEntry);

    try {
      const runtime = await buildPromise;
      placeholderEntry.runtime = runtime;
      delete placeholderEntry.buildPromise;
      return runtime;
    } catch (err) {
      this.cache.delete(key);
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
    if (!activeFp) return;

    const activeKey = this.cacheKey(repoId, activeFp);
    const activeEntry = this.cache.get(activeKey);
    if (!activeEntry || !activeEntry.runtime) return;

    let hasActiveLease: boolean;
    try {
      hasActiveLease = activeEntry.runtime.workerLeaseRepository.checkActiveLease(repoId, now);
    } catch {
      hasActiveLease = true;
    }

    if (hasActiveLease) {
      this.unmarkStale(activeKey);
    } else if (!activeEntry.isStale) {
      this.markStale(activeKey);
    }
  }

  onLeaseAcquired(repoId: RepositoryId): void {
    const activeFp = this.activeFingerprint.get(String(repoId));
    if (!activeFp) return;

    const key = this.cacheKey(repoId, activeFp);
    this.unmarkStale(key);
  }

  close(): void {
    for (const entry of this.cache.values()) {
      try {
        entry.runtime.close();
      } catch {
        // Best-effort: shutdown must not throw
      }
    }
    this.cache.clear();
    this.staleRuntimes.clear();
    this.activeFingerprint.clear();
  }

  getActiveRuntimes(): ReadonlyMap<string, RepositoryRuntime> {
    const result = new Map<string, RepositoryRuntime>();
    for (const [repoIdStr, activeFp] of this.activeFingerprint.entries()) {
      const key = this.cacheKey(repoIdStr as RepositoryId, activeFp);
      const entry = this.cache.get(key);
      if (entry && !entry.isStale) {
        result.set(key, entry.runtime);
      }
    }
    return result;
  }

  isStale(repoId: RepositoryId): boolean {
    const repoIdStr = String(repoId);
    const activeFp = this.activeFingerprint.get(repoIdStr);
    if (!activeFp) return false;

    const key = this.cacheKey(repoId, activeFp);
    const entry = this.cache.get(key);
    return entry?.isStale ?? false;
  }
}

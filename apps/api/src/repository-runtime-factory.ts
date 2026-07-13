import type { RepositoryId } from '@ai-sdlc/domain';
import type { Repository } from '@ai-sdlc/domain';
import type { WorkerLeasePort } from '@ai-sdlc/application';
import type { RepositoryRuntimePaths } from './repository-runtime-paths.js';

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

export interface RepositoryRuntime {
  readonly repository: Repository;
  readonly paths: RepositoryRuntimePaths;
  readonly configFingerprint: string;
  readonly defaultBranch: string;
  readonly fullName: string;
  close(): void;
}

interface CacheEntry {
  runtime: RepositoryRuntime;
  fingerprint: string;
  isStale: boolean;
  markedStaleAt?: Date;
}

export interface RepositoryRuntimeFactoryOptions {
  stateRoot: string;
  loadLayeredConfig: (opts: { automationRoot: string; targetRoot?: string }) => {
    config: unknown;
    fingerprint: string;
    sources: unknown;
  };
  workerLeasePort: WorkerLeasePort;
  now?: () => Date;
}

export class RepositoryRuntimeFactory {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly staleRuntimes = new Set<string>();
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

    for (const key of this.staleRuntimes) {
      const entry = this.cache.get(key);
      if (!entry) {
        this.staleRuntimes.delete(key);
        continue;
      }

      if (this.opts.workerLeasePort.checkActiveLease(entry.runtime.repository.id, now)) {
        this.unmarkStale(key);
        continue;
      }

      try {
        entry.runtime.close();
      } catch {
        // Best-effort: eviction must not throw
      }
      this.cache.delete(key);
      this.staleRuntimes.delete(key);
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
  }

  private resolveGitMetadata(repo: Repository): { defaultBranch: string } {
    return { defaultBranch: repo.defaultBranch };
  }

  private createRuntime(repo: Repository, fingerprint: string): RepositoryRuntime {
    const { RepositoryRuntimePaths } = require('./repository-runtime-paths.js');
    const paths = RepositoryRuntimePaths.create({
      stateRoot: this.opts.stateRoot,
      repository: repo,
    });
    const { defaultBranch } = this.resolveGitMetadata(repo);

    return {
      repository: repo,
      paths,
      configFingerprint: fingerprint,
      defaultBranch,
      fullName: repo.fullName,
      close() {
        // Runtime cleanup - actual implementation would close DB connections,
        // release file handles, etc.
      },
    };
  }

  getRuntime(repo: Repository, fingerprint: string): RepositoryRuntime {
    this.validateRepositoryState(repo);

    const key = this.cacheKey(repo.id, fingerprint);
    const existingEntry = this.cache.get(key);

    if (existingEntry) {
      this.unmarkStale(key);
      return existingEntry.runtime;
    }

    const runtime = this.createRuntime(repo, fingerprint);
    this.cache.set(key, { runtime, fingerprint, isStale: false });

    return runtime;
  }

  onLeaseReleased(repoId: RepositoryId): void {
    const now = this.opts.now?.() ?? new Date();

    for (const [key, entry] of this.cache.entries()) {
      if (String(entry.runtime.repository.id) === String(repoId)) {
        if (this.opts.workerLeasePort.checkActiveLease(repoId, now)) {
          this.unmarkStale(key);
        } else if (!entry.isStale) {
          this.markStale(key);
        }
        break;
      }
    }
  }

  onLeaseAcquired(repoId: RepositoryId): void {
    for (const [key, entry] of this.cache.entries()) {
      if (String(entry.runtime.repository.id) === String(repoId)) {
        this.unmarkStale(key);
        break;
      }
    }
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
  }

  getActiveRuntimes(): ReadonlyMap<string, RepositoryRuntime> {
    const result = new Map<string, RepositoryRuntime>();
    for (const [key, entry] of this.cache.entries()) {
      result.set(key, entry.runtime);
    }
    return result;
  }

  isStale(repoId: RepositoryId): boolean {
    for (const entry of this.cache.values()) {
      if (String(entry.runtime.repository.id) === String(repoId)) {
        return entry.isStale;
      }
    }
    return false;
  }
}

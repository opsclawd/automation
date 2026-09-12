import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import {
  Run,
  RunId,
  RunStatus,
  createRun,
  WorkerId,
  RepositoryId,
  Repository,
  WorkerLeaseConflictError,
  LeaseOwnershipLostError,
  JobOwnershipLostError,
  JobId,
  IssueNumber,
  createJob,
  createWorker,
  generateJobOwnership,
  runStatusToExecutionOutcome,
  type ResumeDisposition,
  type ExecutionPolicy,
  ReleaseBatchId,
} from '@ai-sdlc/domain';
import { newRunId, EXECUTION_POLICIES } from '@ai-sdlc/shared';
import {
  planRunRecoveryAction,
  ReapOrphanedTestWorkers,
  FairRepositoryScheduler,
  runClaimedJob,
  SweepOrphanedRuns,
  checkPid,
  type ArtifactGuardPort,
  resolvePhaseOrder,
  safeDispatchRunNotification,
  DEFAULT_DRAIN_TIMEOUT_MS,
  type RunNotificationPort,
  RunOwnedBlockerError,
} from '@ai-sdlc/application';
import type { WorkerLoopDeps } from '@ai-sdlc/application';
import { composeRoot, type ComposeOptions, type Container, seedTestDatabase } from './compose.js';
import { resolveTargetRepoRootOrExit, findRepoRoot } from './cli/target-repo-root.js';
import { composeWithTarget } from './cli/compose-with-target.js';
import { WorkerScheduler } from './worker-scheduler.js';
import { resolveRepoContext, canonicalizeRepoContext } from './routes/_lib.js';
import { registerRepoCommand } from './cli/repo-commands.js';
import { EXIT_USER_ERROR, EXIT_INTERNAL_ERROR } from './cli/exit-codes.js';
import { schedulerConfigSchema } from '@ai-sdlc/shared';
import { RepositorySchedulerAdapter } from './repository-scheduler-adapter.js';
import type { RepositoryRuntime } from './repository-runtime-factory.js';
import { ShutdownCoordinator } from './shutdown-coordinator.js';

export interface SchedulerConfig {
  globalConcurrency: number;
  pollIntervalMs: number;
  shutdownGraceMs: number;
}

export interface LeaseConfig {
  ttlMs: number;
  heartbeatIntervalMs: number;
}

const DEFAULT_LEASE_TTL_MS = 120_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

const EXIT_SIGINT = 130;
const EXIT_SIGTERM = 143;

/**
 * Await startup sweep completion and pending notification drain before exiting.
 * Centralizes one-shot CLI exit handling to ensure terminal status notifications
 * (e.g. from offline PR merges discovered on startup) are never dropped.
 */
export async function drainAndExit(
  container: Container | undefined,
  exitCode: number,
  timeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS,
  sweepPromise?: Promise<unknown>,
): Promise<never> {
  if (sweepPromise && container?.trackStartupSweep) {
    container.trackStartupSweep(sweepPromise);
  }
  try {
    if (sweepPromise) {
      if (timeoutMs > 0) {
        let timer: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        });
        try {
          await Promise.race([sweepPromise.catch(() => {}), timeoutPromise]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } else {
        await sweepPromise.catch(() => {});
      }
    }
    await container?.drainStartupSweeps?.(timeoutMs);
  } catch {}
  try {
    await container?.runNotification?.drain?.(timeoutMs);
  } catch {}
  try {
    await container?.releaseBatchNotification?.drain?.(timeoutMs);
  } catch {}
  process.exit(exitCode);
}

export interface BuildProgramOptions {
  composeOverrides?: Partial<ComposeOptions>;
  lease?: Partial<LeaseConfig>;
  isCliTestSuite?: boolean;
  bypassPlanValidation?: boolean;
  schedulerConfig?: SchedulerConfig;
}

interface LeaseRepo {
  heartbeat(input: {
    repoId: RepositoryId;
    workerId: WorkerId;
    runId: RunId;
    now: Date;
    newExpiresAt: Date;
    leaseToken: string;
  }): void;
  release(input: {
    repoId: RepositoryId;
    workerId: WorkerId;
    runId: RunId;
    leaseToken: string;
  }): void;
}

// Event types that are recorded (persisted to the DB, available for later
// inspection/measurement) but not worth printing to the live --verbose CLI
// stream: they carry no actionable signal for a human watching progress,
// just internal bookkeeping (e.g. a retry-dedup fingerprint hash).
const CLI_STREAM_SUPPRESSED_EVENT_TYPES: ReadonlySet<string> = new Set(['semantic_retry']);

function shouldStreamEventToCli(event: { type: string }): boolean {
  return !CLI_STREAM_SUPPRESSED_EVENT_TYPES.has(event.type);
}

function startLeaseHeartbeat(
  leaseRepo: LeaseRepo,
  repoId: RepositoryId,
  workerId: WorkerId,
  runId: RunId,
  leaseToken: string,
  ttlMs: number,
  intervalMs: number,
  onFatalExit?: (exitCode: number) => Promise<never> | Promise<void> | void,
): { stop: () => void } {
  let heartbeatFailures = 0;
  const maxHeartbeatFailures = Math.max(1, Math.ceil(ttlMs / intervalMs) - 1);
  const timer = setInterval(() => {
    const hbNow = new Date();
    try {
      leaseRepo.heartbeat({
        repoId,
        workerId,
        runId,
        now: hbNow,
        newExpiresAt: new Date(hbNow.getTime() + ttlMs),
        leaseToken,
      });
      heartbeatFailures = 0;
    } catch (err) {
      if (err instanceof LeaseOwnershipLostError) {
        console.error(`Fatal: lease ownership lost, exiting.`);
        clearInterval(timer);
        if (onFatalExit) {
          void onFatalExit(EXIT_INTERNAL_ERROR);
          return;
        }
        process.exit(EXIT_INTERNAL_ERROR);
      }
      heartbeatFailures++;
      if (heartbeatFailures >= maxHeartbeatFailures) {
        console.error(`Fatal: heartbeat failed ${heartbeatFailures}x, aborting run.`);
        clearInterval(timer);
        try {
          leaseRepo.release({ repoId, workerId, runId, leaseToken });
        } catch {}
        if (onFatalExit) {
          void onFatalExit(EXIT_INTERNAL_ERROR);
          return;
        }
        process.exit(EXIT_INTERNAL_ERROR);
      }
      console.error(
        `Warning: heartbeat failed (${heartbeatFailures}x): ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
      leaseRepo.release({ repoId, workerId, runId, leaseToken });
    },
  };
}

const DEFAULT_WORKER_REGISTRY_HEARTBEAT_INTERVAL_MS = 30_000;

function printRunFailureSummary(uuid: string, reason?: string, status?: RunStatus): void {
  let prefix: string;
  if (status === 'needs_human_review') {
    prefix = reason ? `Run needs human review: ${reason}` : 'Run needs human review.';
  } else if (status === 'blocked') {
    prefix = reason ? `Run blocked: ${reason}` : 'Run blocked.';
  } else {
    prefix = reason ? `Run failed: ${reason}` : 'Run failed.';
  }
  console.error(prefix);
  console.error(`Run UUID: ${uuid}`);
  // No --confirm in the hint: `runs resume` intentionally stops and warns
  // when the failed phase is unsafe to retry, and pre-confirming would skip
  // that guard for anyone who copy-pastes the command.
  console.error(`Resume with: orchestrator runs resume --uuid ${uuid}`);
}

function startWorkerRegistryHeartbeat(
  registry: { heartbeat(id: WorkerId, repoId: RepositoryId, now: Date): void },
  workerId: WorkerId,
  repoId: RepositoryId,
  intervalMs: number,
): { stop: () => void } {
  const timer = setInterval(() => {
    try {
      registry.heartbeat(workerId, repoId, new Date());
    } catch (err) {
      console.error(
        `worker-registry heartbeat failed for ${workerId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}

const TEST_WORKER_REAP_INTERVAL_MS = 5 * 60 * 1000;

function startTestWorkerReaper(
  reaper: ReapOrphanedTestWorkers,
  intervalMs: number = TEST_WORKER_REAP_INTERVAL_MS,
): {
  stop: () => void;
} {
  const timer = setInterval(() => {
    try {
      const result = reaper.execute();
      if (result.reaped > 0) {
        console.error(`Reaped ${result.reaped} orphaned test worker(s): ${result.pids.join(', ')}`);
      }
    } catch (err) {
      console.error(
        `Orphaned test worker reap failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}

export function installSignalHandlers(
  runRepository: {
    findByIssueNumber(repoId: RepositoryId, n: number): { pid?: number | null } | undefined;
    updateStatusByIssueNumber(
      repoId: RepositoryId,
      issueNumber: number,
      patch: { status: RunStatus; completedAt: Date; failureReason?: string },
    ): boolean;
  },
  repoId: RepositoryId,
  issueNumber: number,
  onCleanup?: () => void | Promise<void>,
  onExit?: (exitCode: number) => Promise<never> | Promise<void> | void,
): { remove: () => void } {
  const cleanup = async (signal: string) => {
    const existing = runRepository.findByIssueNumber(repoId, issueNumber);
    if (existing && existing.pid === process.pid) {
      // eslint-disable-next-line no-console
      console.debug(
        'terminal status write starting',
        `issueNumber=${issueNumber}`,
        'status=cancelled',
      );
      let applied = true;
      try {
        applied = runRepository.updateStatusByIssueNumber(repoId, issueNumber, {
          status: 'cancelled',
          completedAt: new Date(),
          failureReason: `interrupted by ${signal}`,
        });
        // eslint-disable-next-line no-console
        console.debug(
          'terminal status write completed',
          `issueNumber=${issueNumber}`,
          'status=cancelled',
          `applied=${applied}`,
        );
      } catch (err) {
        console.error('Terminal status write failed', err);
        applied = false;
      }
    }
    try {
      await onCleanup?.();
    } catch {}
  };

  const exitWith = (code: number) => {
    if (onExit) {
      void onExit(code);
      return;
    }
    process.exit(code);
  };

  const sigintHandler = () => {
    cleanup('SIGINT').finally(() => exitWith(EXIT_SIGINT));
  };
  const sigtermHandler = () => {
    cleanup('SIGTERM').finally(() => exitWith(EXIT_SIGTERM));
  };
  const uncaughtHandler = (err: Error) => {
    cleanup('uncaughtException').finally(() => {
      console.error(err instanceof Error ? err.message : String(err));
      exitWith(EXIT_USER_ERROR);
    });
  };
  const unhandledHandler = (reason: unknown) => {
    cleanup('unhandledRejection').finally(() => {
      console.error(reason instanceof Error ? reason.message : String(reason));
      exitWith(EXIT_USER_ERROR);
    });
  };

  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);
  process.on('uncaughtException', uncaughtHandler);
  process.on('unhandledRejection', unhandledHandler);

  return {
    remove: () => {
      process.off('SIGINT', sigintHandler);
      process.off('SIGTERM', sigtermHandler);
      process.off('uncaughtException', uncaughtHandler);
      process.off('unhandledRejection', unhandledHandler);
    },
  };
}

export function reconcileStrandedRun(
  run: { uuid: string; repoId: RepositoryId; issueNumber: number; displayId: string },
  runRepository: {
    atomicUpdateByUuid(
      uuid: string,
      patch: { status: RunStatus; completedAt: Date; failureReason?: string },
      expectedCurrentStatus: RunStatus,
    ): boolean;
  },
  failureReason: string,
  runNotification?: RunNotificationPort,
): boolean {
  // eslint-disable-next-line no-console
  console.debug(
    'terminal status write starting',
    `runUuid=${run.uuid}`,
    'status=failed',
    `reason=${failureReason}`,
  );
  let applied = true;
  try {
    applied = runRepository.atomicUpdateByUuid(
      run.uuid,
      {
        status: 'failed',
        completedAt: new Date(),
        failureReason,
      },
      'running',
    );
    if (applied && runNotification) {
      safeDispatchRunNotification(runNotification, {
        status: 'failed',
        repoId: run.repoId,
        issueNumber: run.issueNumber,
        displayId: run.displayId,
        failureReason,
      });
    }
    // eslint-disable-next-line no-console
    console.debug(
      'terminal status write completed',
      `runUuid=${run.uuid}`,
      'status=failed',
      `applied=${applied}`,
    );
  } catch (err) {
    console.error('Terminal status write failed', err);
    applied = false;
  }
  return applied;
}

export { findRepoRoot };

export interface RunCliOptions {
  issue: number;
  script: string;
  baseBranch?: string;
  model?: string;
  agentCli?: string;
  executor?: string;
  targetRepoRoot?: string;
  repositoryId?: string;
  executionPolicy?: string;
  strict?: boolean;
  allowProtectedPath?: string[];
}

export function resolveCliRepoId(
  opts: { repositoryId?: string | undefined },
  container: {
    listEnabledRepositories(): Array<{ id: string; fullName: string }>;
    repoFullName: string | undefined;
  },
): string | undefined {
  if (opts.repositoryId) return opts.repositoryId;
  const enabled = container.listEnabledRepositories();
  if (container.repoFullName) {
    const matched = enabled.find((r) => r.fullName === container.repoFullName);
    if (matched) return matched.id;
  }
  if (enabled.length === 1 && enabled[0]) return enabled[0].id;
  if (enabled.length > 1) {
    throw new Error(
      `--repository-id is required when more than one repository is enabled (${enabled.map((r) => r.fullName).join(', ')})`,
    );
  }
  return undefined;
}

export function resolveRepoIdForCli(
  opts: { repositoryId?: string | undefined },
  c: {
    listRepositories: {
      execute(opts?: { includeDisabled?: boolean }): Array<{ id: RepositoryId; fullName: string }>;
    };
    repoFullName?: string;
    inspectRepository: { executeByFullName(fullName: string): { id: RepositoryId } };
  },
): string | undefined {
  const resolvedRepoIdStr = resolveCliRepoId(opts, {
    repoFullName: c.repoFullName,
    listEnabledRepositories: () =>
      c.listRepositories.execute({ includeDisabled: false }).map((r) => ({
        id: r.id,
        fullName: r.fullName,
      })),
  });

  if (!resolvedRepoIdStr) return undefined;

  const ctx = resolveRepoContext({ headers: {}, query: { repositoryId: resolvedRepoIdStr } }, c);

  if (ctx.repositoryId || ctx.fullName) {
    return canonicalizeRepoContext(ctx, c);
  }
  return undefined;
}

function buildSchedulerLogger() {
  return {
    debug: (msg: string, ...args: unknown[]) =>
      // eslint-disable-next-line no-console
      console.debug(`[scheduler] ${msg}`, ...args),
    info: (msg: string, ...args: unknown[]) =>
      // eslint-disable-next-line no-console
      console.info(`[scheduler] ${msg}`, ...args),
    warn: (msg: string, ...args: unknown[]) => console.warn(`[scheduler] ${msg}`, ...args),
    error: (msg: string, ...args: unknown[]) => console.error(`[scheduler] ERROR: ${msg}`, ...args),
  };
}

function buildSchedulerDeps(
  c: Container,
  workerIdPrefix: string,
  logger: ReturnType<typeof buildSchedulerLogger>,
) {
  const workSourceAdapter = new RepositorySchedulerAdapter({
    runtimeFactory: async (repo) => {
      const result = await c.runtimeCatalog.resolve(repo.id);
      return result;
    },
    logger,
  });

  const schedulerWorkerLoop = async (
    runtime: RepositoryRuntime,
    input: { workerId: WorkerId; runId: RunId; signal?: AbortSignal },
  ) => {
    const { workerId, runId, signal } = input;

    // The scheduler (RepositorySchedulerAdapter.runOne) has already claimed a
    // job for this run before invoking this callback. Look it up so the job
    // claim is always explicitly settled, never silently leaked, even if we
    // bail out below before actual execution.
    const job = runtime.jobQueue
      .listForRun(runId)
      .find((j) => j.claimedBy === workerId && j.status === 'claimed');

    const runExecutor = c.runExecutor;
    if (!runExecutor) {
      logger.warn(`No runExecutor available in container to run job ${String(runId)}`);
      if (job && job.claimedBy && job.claimToken) {
        const ownership = generateJobOwnership(job, job.claimedBy);
        try {
          runtime.jobQueue.markFailed(ownership, new Date());
        } catch (err) {
          if (!(err instanceof JobOwnershipLostError)) throw err;
        }
      }
      return;
    }

    if (!job) {
      logger.warn(`No claimed job found for run ${String(runId)} claimed by ${String(workerId)}`);
      return;
    }

    const fullDeps: WorkerLoopDeps = {
      registry: runtime.workerRegistry,
      queue: runtime.jobQueue,
      leases: runtime.workerLeaseRepository,
      repos: runtime.workerLoopDeps.repos,
      repoId: runtime.repository.id,
      executeRun: async ({ run: r, signal, resumeDisposition }) => {
        runtime.runRepository.update(r.uuid, { pid: process.pid });
        const controller = new AbortController();
        const onAbort = () => {
          controller.abort(signal?.reason);
        };
        if (signal) {
          if (signal.aborted) {
            controller.abort(signal.reason);
          } else {
            signal.addEventListener('abort', onAbort, { once: true });
          }
        }
        let doneResolve!: () => void;
        const donePromise = new Promise<void>((resolve) => {
          doneResolve = resolve;
        });
        c.runAbort.register(RunId(r.uuid), controller, donePromise);
        try {
          const result = await runExecutor.execute({
            run: r,
            skip: [],
            presentArtifacts: [],
            ...(resumeDisposition !== undefined ? { resumeDisposition } : {}),
          });
          return { outcome: runStatusToExecutionOutcome(result.run.status) };
        } finally {
          doneResolve();
          c.runAbort.unregister(RunId(r.uuid));
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
        }
      },
      prepareWorktree: async ({ repoId: _repoId, runId: rId }) => {
        const r = runtime.runRepository.findByUuid(rId);
        if (!r) throw new Error(`prepareWorktree: no run found for ${rId}`);
        const repo = runtime.repository;
        const repoRootPath = repo.localBasePath;
        const repoDefaultBranch = repo.defaultBranch;
        const worktreePath = join(repoRootPath, '.ai-worktrees', `issue-${r.issueNumber}`);
        const baseBranch = r.baseBranch ?? repoDefaultBranch;
        await c.git.createWorktree({
          repoLocalBasePath: repoRootPath,
          worktreePath,
          branch: `ai/issue-${r.issueNumber}`,
          baseBranch,
        });
        if ('seedArtifactExcludes' in c.git) {
          await (c.git as unknown as ArtifactGuardPort).seedArtifactExcludes(worktreePath);
        }
        const sha = await c.git.headCommitSha(worktreePath);
        runtime.runRepository.update(r.uuid, { startCommitSha: sha });
        return { cwd: worktreePath };
      },
      resetWorktree: (repoId) => {
        const lease = runtime.workerLeaseRepository.current(repoId);
        if (!lease) return;
        const r = runtime.runRepository.findByUuid(lease.runId);
        if (!r) return;
        const repo = runtime.repository;
        const repoRootPath = repo.localBasePath;
        const repoDefaultBranch = repo.defaultBranch;
        const worktreePath = join(repoRootPath, '.ai-worktrees', `issue-${r.issueNumber}`);
        const baseBranch = r.baseBranch ?? repoDefaultBranch;
        c.git.resetWorktreeIfClean(worktreePath, baseBranch).catch(() => {});
      },
      isWorkerAlive: (wId) => {
        const w = runtime.workerRegistry.findById(wId, runtime.repository.id);
        if (!w) return false;
        if (w.hostname !== os.hostname()) {
          return Date.now() - w.heartbeatAt.getTime() < DEFAULT_LEASE_TTL_MS;
        }
        return checkPid(w.processId);
      },
      findRun: (rId) => runtime.runRepository.findByUuid(rId) ?? undefined,
      updateRun: (runId, patch) => runtime.runRepository.update(String(runId), patch),
      now: () => new Date(),
      ttlMs: DEFAULT_LEASE_TTL_MS,
      ...(signal && { outerSignal: signal }),
    };

    await runClaimedJob(workerId, job, fullDeps);
  };

  const dispatchAdapter = new RepositorySchedulerAdapter({
    runtimeFactory: async (repo) => {
      const result = await c.runtimeCatalog.resolve(repo.id);
      return result;
    },
    logger,
    workerLoop: schedulerWorkerLoop,
  });

  return {
    repos: {
      listEnabled: () => c.listRepositories.execute(),
    },
    workSource: workSourceAdapter,
    dispatch: dispatchAdapter,
    telemetry: {
      record: () => {},
    },
    workerIdFactory: (repo: Repository, seq: number) =>
      WorkerId(`${workerIdPrefix}-${process.pid}-${String(repo.id)}-${seq}`),
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) return;
      await sleep(ms, signal);
    },
    now: () => new Date(),
    logger,
  };
}

function getOrCreateScheduler(
  c: Container,
  workerIdPrefix: string,
  opts: { globalConcurrency?: number; pollIntervalMs?: number },
  buildOpts?: BuildProgramOptions,
): FairRepositoryScheduler {
  const schedulerLogger = buildSchedulerLogger();
  const globalConcurrency =
    opts.globalConcurrency ??
    buildOpts?.schedulerConfig?.globalConcurrency ??
    c.schedulerConfig.globalConcurrency;
  const pollIntervalMs =
    opts.pollIntervalMs ??
    buildOpts?.schedulerConfig?.pollIntervalMs ??
    c.schedulerConfig.pollIntervalMs;

  const schedulerDeps = {
    globalConcurrency,
    pollIntervalMs,
    ...buildSchedulerDeps(c, workerIdPrefix, schedulerLogger),
  };
  return new FairRepositoryScheduler(schedulerDeps);
}

export function buildProgram(buildOpts?: BuildProgramOptions): Command {
  const program = new Command();

  program.name('orchestrator').description('AI SDLC Orchestrator CLI').version('0.0.0');

  program
    .command('run')
    .alias('start')
    .description('Start an issue-to-PR run with the TypeScript executor by default')
    .option('--repository-id <id|owner/name>', 'Repository ID or owner/name')
    .requiredOption('--issue <number>', 'GitHub issue number', (v) => {
      if (!/^\d+$/.test(v)) throw new Error(`--issue must be a positive integer, got: ${v}`);
      const n = parseInt(v, 10);
      if (n < 1) throw new Error(`--issue must be >= 1, got: ${v}`);
      return n;
    })
    .option(
      '--base-branch <branch>',
      'Base branch (default: target repository default branch). Used for worktree creation, PR target, and PR-review polling.',
    )
    .option(
      '--model <model>',
      'AI_AGENT_MODEL env var (Bash executor only). Rejected for --executor ts.',
    )
    .option(
      '--agent-cli <cli>',
      'AI_RUNTIME env var (Bash executor only). Rejected for --executor ts.',
    )
    .option('--script <path>', 'Path to Bash script to wrap')
    .option('--verbose', 'Stream script stdout/stderr to terminal (default: auto when TTY)')
    .option('--no-verbose', 'Suppress streaming script output to terminal')
    .option(
      '--executor <executor>',
      'Execution engine: ts (default, TypeScript RunExecutor) or bash (legacy, emergency use only)',
      'ts',
    )
    .option('--execution-policy <policy>', 'Execution policy: standard | strict | legacy')
    .option('--strict', 'Convenience shortcut for --execution-policy strict')
    .option(
      '--target-repo-root <path>',
      'Target repository root for worktrees and DB (default: orchestrator repo)',
    )
    .option(
      '--allow-protected-path <path>',
      'Allow modifying protected path in create-pr guard (repeatable)',
      (val: string, prev: string[] = []) => [...prev, val],
    )
    .action(async (opts: RunCliOptions & { verbose?: boolean }) => {
      let containerRef: Container | undefined;
      try {
        const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
          console.error(`Error: ${msg}`);
          process.exit(EXIT_USER_ERROR);
        });
        const tee = opts.verbose ?? Boolean(process.stdout.isTTY);
        const { c, repoRoot } = composeWithTarget(targetRepoRoot, {
          ...(buildOpts !== undefined ? { buildOpts } : {}),
          ...(opts.script !== undefined ? { scriptPath: opts.script } : {}),
          runStartupSweeps: true,
          composeOverrides: {
            tee,
            ...(opts.baseBranch !== undefined ? { baseBranch: opts.baseBranch } : {}),
            ...(opts.model !== undefined ? { model: opts.model } : {}),
            ...(opts.agentCli !== undefined ? { agentCli: opts.agentCli } : {}),
            ...(opts.allowProtectedPath !== undefined
              ? { allowProtectedPaths: opts.allowProtectedPath }
              : {}),
          },
        });
        containerRef = c;
        if (tee) c.runRepository; // tee consumed below by run command's existing logic
        if (opts.baseBranch !== undefined && c.runRepository) {
          // baseBranch is propagated via the helper, no extra wiring needed
        }

        // --- executor validation ---
        if (opts.executor && !['bash', 'ts'].includes(opts.executor)) {
          console.error(`Error: --executor must be "bash" or "ts", got "${opts.executor}"`);
          await drainAndExit(c, EXIT_USER_ERROR);
          return;
        }

        // --- execution policy validation ---
        let resolvedExecutionPolicy: ExecutionPolicy | undefined;
        if (opts.strict && opts.executionPolicy !== undefined) {
          if (opts.executionPolicy !== 'strict') {
            console.error(
              `Error: conflicting options --strict and --execution-policy ${opts.executionPolicy}. ` +
                `Use either --strict or --execution-policy <policy>.`,
            );
            await drainAndExit(c, EXIT_USER_ERROR);
            return;
          }
          resolvedExecutionPolicy = 'strict';
        } else if (opts.strict) {
          resolvedExecutionPolicy = 'strict';
        } else if (opts.executionPolicy !== undefined) {
          if (!(EXECUTION_POLICIES as readonly string[]).includes(opts.executionPolicy)) {
            console.error(
              `Error: --execution-policy must be "standard" or "strict", got "${opts.executionPolicy}"`,
            );
            await drainAndExit(c, EXIT_USER_ERROR);
            return;
          }
          resolvedExecutionPolicy = opts.executionPolicy as ExecutionPolicy;
        }

        const effectiveExecutionPolicy = resolvedExecutionPolicy ?? c.executionPolicy ?? 'standard';

        // --- flag-combination validation ---
        if (opts.executor === 'ts' && (opts.model !== undefined || opts.agentCli !== undefined)) {
          const conflicting = [
            ...(opts.model !== undefined ? ['--model'] : []),
            ...(opts.agentCli !== undefined ? ['--agent-cli'] : []),
          ];
          console.error(
            `Error: ${conflicting.join(' and ')} only apply to --executor bash. ` +
              `The TypeScript executor selects model and runtime from configured phase profiles. ` +
              `Re-run without ${conflicting.join(' and ')}, or pass --executor bash to use the legacy path.`,
          );
          await drainAndExit(c, EXIT_USER_ERROR);
          return;
        }

        const pausedStatuses: RunStatus[] = ['waiting', 'queued'];

        // --- TS executor path ---
        if (opts.executor === 'ts') {
          if (!c.runExecutor) {
            console.error(
              'Error: RunExecutor not available. Ensure agent config is present in .ai-orchestrator.json.',
            );
            await drainAndExit(c, EXIT_USER_ERROR);
            return;
          }

          const callerRepoId = resolveRepoIdForCli({ repositoryId: opts.repositoryId }, c);
          const repoId = callerRepoId
            ? (callerRepoId as RepositoryId)
            : c.repoFullName
              ? RepositoryId(c.repoFullName)
              : undefined;
          if (!repoId) {
            console.error(
              'Error: could not determine repository name. Ensure gh CLI is authenticated and run from a GitHub repository.',
            );
            await drainAndExit(c, EXIT_USER_ERROR);
            return;
          }

          if (!c.workerRegistry || !c.workerLoopDeps) {
            console.error(
              'Error: worker registry not available. Ensure agent config is present in .ai-orchestrator.json.',
            );
            await drainAndExit(c, EXIT_USER_ERROR);
            return;
          }

          const startedAt = new Date();
          const ids = newRunId({ issueNumber: opts.issue, now: startedAt });

          // Resolve the effective base branch and validate it exists on the
          // target repo's remote before creating any worktree/job/run state.
          // resolvedDefaultBranch comes from composeWithTarget's gh-based
          // resolution; opts.baseBranch, when provided, wins.
          const effectiveBaseBranch = opts.baseBranch ?? c.repoDefaultBranch ?? '';
          if (effectiveBaseBranch) {
            const exists = await c.git.remoteRef({
              cwd: repoRoot,
              remote: 'origin',
              ref: effectiveBaseBranch,
            });
            if (exists === undefined) {
              console.error(
                `Error: --base-branch "${effectiveBaseBranch}" was not found on origin of ${repoRoot}. ` +
                  `Check the branch name, fetch from origin, or omit --base-branch to use the repository's default branch.`,
              );
              await drainAndExit(c, EXIT_USER_ERROR);
              return;
            }
          }

          const run = createRun({
            uuid: ids.uuid,
            displayId: ids.displayId,
            repoId,
            issueNumber: opts.issue,
            startedAt,
            executionPolicy: effectiveExecutionPolicy,
            ...(effectiveBaseBranch ? { baseBranch: effectiveBaseBranch } : {}),
          });

          if (callerRepoId) {
            c.loadRepositoryForRun.execute({
              run,
              callerRepoId: callerRepoId as RepositoryId,
              strictMatch: false,
            });
          }

          const effectivePhases = resolvePhaseOrder(effectiveExecutionPolicy);
          console.error(`Execution policy: ${effectiveExecutionPolicy.toUpperCase()}`);
          console.error('Phase graph:');
          for (const p of effectivePhases) {
            console.error(`  ${p}`);
          }

          const jobId = JobId(randomUUID());
          const workerId = WorkerId(`cli-${process.pid}`);
          const abortController = new AbortController();

          let unsubscribe: (() => void) | undefined;
          let sigintHandler: (() => void) | undefined;
          let sigtermHandler: (() => void) | undefined;
          let workerHeartbeat: { stop: () => void } | undefined;
          let testWorkerReaper: { stop: () => void } | undefined;

          try {
            c.runRepository.insertIfNoActive(run);

            c.eventBus.publish(run.uuid, {
              runId: run.displayId,
              level: 'info',
              type: 'run.config',
              message: `run.config: executor=ts executionPolicy=${run.executionPolicy ?? 'standard'} baseBranch=${effectiveBaseBranch || '(default)'}`,
              timestamp: startedAt.toISOString(),
              metadata: {
                executor: 'ts',
                executionPolicy: run.executionPolicy ?? 'standard',
                baseBranch: effectiveBaseBranch || null,
              },
            });

            const job = createJob({
              id: jobId,
              runId: RunId(run.uuid),
              repoId,
              issueNumber: IssueNumber(opts.issue),
              priority: 0,
              createdAt: startedAt,
            });
            c.jobQueue.enqueue({ job });

            c.workerRegistry.register(
              createWorker({
                id: workerId,
                repoId,
                hostname: os.hostname(),
                processId: process.pid,
                now: startedAt,
              }),
            );

            workerHeartbeat = startWorkerRegistryHeartbeat(
              c.workerRegistry,
              workerId,
              repoId,
              buildOpts?.lease?.heartbeatIntervalMs ??
                DEFAULT_WORKER_REGISTRY_HEARTBEAT_INTERVAL_MS,
            );
            testWorkerReaper = startTestWorkerReaper(c.reapOrphanedTestWorkers);

            if (tee) {
              unsubscribe = c.eventBus.subscribe(ids.uuid, (event) => {
                if (shouldStreamEventToCli(event)) {
                  console.error(`[ts] ${event.message}`);
                }
              });
            }

            const handleSignal = async (signal: string, exitCode: number) => {
              try {
                abortController.abort();
                testWorkerReaper?.stop();
                const currentJob = c.jobQueue.findById(jobId);
                if (currentJob) {
                  if (
                    currentJob.status === 'claimed' &&
                    currentJob.claimedBy &&
                    currentJob.claimToken
                  ) {
                    try {
                      const ownership = generateJobOwnership(currentJob, currentJob.claimedBy);
                      c.jobQueue.releaseClaim(ownership);
                    } catch (err) {
                      console.error(
                        `releaseClaim on signal failed: ${err instanceof Error ? err.message : String(err)}`,
                      );
                    }
                  } else if (
                    currentJob.status === 'running' &&
                    currentJob.claimedBy &&
                    currentJob.claimToken
                  ) {
                    try {
                      const ownership = generateJobOwnership(currentJob, currentJob.claimedBy);
                      c.jobQueue.markCancelled(ownership, new Date());
                    } catch (err) {
                      console.error(
                        `markCancelled on signal failed: ${err instanceof Error ? err.message : String(err)}`,
                      );
                    }
                  }
                  // 'queued' is a no-op: the workerLoop's first tick will reclaim naturally.
                }
                workerHeartbeat?.stop();
                // eslint-disable-next-line no-console
                console.debug(
                  'terminal status write starting',
                  `runUuid=${run.uuid}`,
                  'status=cancelled',
                );
                let applied = true;
                try {
                  applied = c.runRepository.atomicUpdateByUuid(
                    run.uuid,
                    {
                      status: 'cancelled',
                      completedAt: new Date(),
                      failureReason: `interrupted by ${signal}`,
                    },
                    'running',
                  );
                  // eslint-disable-next-line no-console
                  console.debug(
                    'terminal status write completed',
                    `runUuid=${run.uuid}`,
                    'status=cancelled',
                    `applied=${applied}`,
                  );
                } catch (err) {
                  console.error('Terminal status write failed', err);
                  applied = false;
                }
                unsubscribe?.();
              } finally {
                await drainAndExit(c, exitCode);
              }
            };

            sigintHandler = () => {
              void handleSignal('SIGINT', EXIT_SIGINT);
            };
            sigtermHandler = () => {
              void handleSignal('SIGTERM', EXIT_SIGTERM);
            };
            process.once('SIGINT', sigintHandler);
            process.once('SIGTERM', sigtermHandler);

            const scheduler = new WorkerScheduler([workerId], c.workerLoopDeps(repoId));

            await scheduler.runUntilComplete(jobId, abortController.signal);

            if (abortController.signal.aborted) {
              const finalJobAfterAbort = c.jobQueue.findById(jobId);
              const finalRunAfterAbort = c.runRepository.findByUuid(run.uuid);
              if (
                finalRunAfterAbort &&
                finalRunAfterAbort.status === 'running' &&
                finalJobAfterAbort &&
                !['succeeded', 'failed', 'cancelled'].includes(finalJobAfterAbort.status)
              ) {
                // eslint-disable-next-line no-console
                console.debug(
                  'terminal status write starting',
                  `runUuid=${run.uuid}`,
                  'status=cancelled',
                );
                let applied = true;
                try {
                  applied = c.runRepository.atomicUpdateByUuid(
                    run.uuid,
                    {
                      status: 'cancelled',
                      completedAt: new Date(),
                      failureReason: 'aborted during scheduler run',
                    },
                    'running',
                  );
                  // eslint-disable-next-line no-console
                  console.debug(
                    'terminal status write completed',
                    `runUuid=${run.uuid}`,
                    'status=cancelled',
                    `applied=${applied}`,
                  );
                } catch (err) {
                  console.error('Terminal status write failed', err);
                  applied = false;
                }
              }
            }

            if (sigintHandler) process.off('SIGINT', sigintHandler);
            if (sigtermHandler) process.off('SIGTERM', sigtermHandler);
            workerHeartbeat?.stop();

            const finalJob = c.jobQueue.findById(jobId);
            let finalRun = c.runRepository.findByUuid(run.uuid) ?? run;

            // If the job reached a terminal failed/cancelled state but the run
            // record is still 'running' (e.g. workerLoop failed before
            // RunExecutor could persist a terminal status), finalize it now so
            // insertIfNoActive doesn't reject the next attempt for this repo/issue.
            // atomicUpdateByUuid guards against a concurrent cancel webhook
            // overwriting a just-set 'cancelled' status.
            if (
              finalRun.status === 'running' &&
              (finalJob?.status === 'failed' || finalJob?.status === 'cancelled')
            ) {
              reconcileStrandedRun(
                run,
                c.runRepository,
                'worker loop terminated without finalizing run',
                c.runNotification,
              );
              finalRun = c.runRepository.findByUuid(run.uuid) ?? finalRun;
            }

            if (finalRun.status === 'passed') {
              const worktreePath = join(repoRoot, '.ai-worktrees', `issue-${opts.issue}`);
              try {
                await c.git.removeWorktree(worktreePath);
              } catch {
                // best-effort
              }
            }

            const phases = c.phaseRepository.listByRun(run.uuid);
            await new Promise<void>((resolve, reject) =>
              process.stdout.write(
                JSON.stringify({ jobId, workerId, run: finalRun, phases }) + '\n',
                (err) => (err ? reject(err) : resolve()),
              ),
            );

            testWorkerReaper?.stop();
            unsubscribe?.();
            const pausedStatuses: RunStatus[] = ['waiting', 'queued'];
            const nonSuccessStatuses: RunStatus[] = [
              'blocked',
              'needs_human_review',
              'failed',
              'cancelled',
            ];
            const isSuccess =
              finalRun.status === 'passed' ||
              pausedStatuses.includes(finalRun.status) ||
              (finalJob?.status === 'succeeded' && !nonSuccessStatuses.includes(finalRun.status));
            if (!isSuccess) {
              printRunFailureSummary(finalRun.uuid, finalRun.failureReason, finalRun.status);
            }
            await drainAndExit(c, isSuccess ? 0 : EXIT_USER_ERROR);
            return;
          } catch (err) {
            if (sigintHandler) process.off('SIGINT', sigintHandler);
            if (sigtermHandler) process.off('SIGTERM', sigtermHandler);
            workerHeartbeat?.stop();
            testWorkerReaper?.stop();
            unsubscribe?.();
            // Finalize a stale 'running' run so insertIfNoActive doesn't block
            // the next attempt. atomicUpdateByUuid is a no-op if the run was
            // never inserted or was already finalized by workerLoop.
            const failureReason = err instanceof Error ? err.message : String(err);
            reconcileStrandedRun(run, c.runRepository, failureReason, c.runNotification);
            // Only suggest resuming if the run row actually exists —
            // insertIfNoActive may have thrown before inserting it.
            if (c.runRepository.findByUuid(run.uuid)) {
              printRunFailureSummary(run.uuid, failureReason, run.status);
            } else {
              console.error(`Run failed: ${failureReason}`);
            }
            await drainAndExit(c, EXIT_USER_ERROR);
            return;
          }
        } else {
          // --- Bash executor path ---
          const callerRepoId = resolveRepoIdForCli({ repositoryId: opts.repositoryId }, c);
          const repoId = callerRepoId
            ? (callerRepoId as RepositoryId)
            : c.repoFullName
              ? RepositoryId(c.repoFullName)
              : undefined;
          if (!repoId) {
            console.error(
              'Error: could not determine repository name. Ensure gh CLI is authenticated and run from a GitHub repository.',
            );
            await drainAndExit(c, EXIT_USER_ERROR);
            return;
          }

          if (callerRepoId) {
            const dummyRun = { repoId, uuid: '' } as Run;
            c.loadRepositoryForRun.execute({
              run: dummyRun,
              callerRepoId: callerRepoId as RepositoryId,
              strictMatch: false,
            });
          }

          const signalHandlers = installSignalHandlers(
            c.runRepository,
            repoId,
            opts.issue,
            undefined,
            (exitCode) => drainAndExit(c, exitCode),
          );

          try {
            const out = await c.startIssueRun.execute({
              issueNumber: opts.issue,
              repoId,
              executionPolicy: effectiveExecutionPolicy,
            });
            // Use process.stdout.write with a callback (not console.log) because
            // process.exit() does not wait for stdout to flush.
            await new Promise<void>((resolve, reject) =>
              process.stdout.write(JSON.stringify(out) + '\n', (err) =>
                err ? reject(err) : resolve(),
              ),
            );
            // Remove handlers before process.exit (which bypasses finally). No
            // persistent state leaks on this path (the bash run holds no
            // WorkerLease), so this is consistency/defensive only — but it keeps
            // the same discipline as the TS path. The finally still covers the
            // throw case, where it does run before the error propagates.
            signalHandlers.remove();
            const isSuccess =
              out.status === 'passed' || pausedStatuses.includes(out.status as RunStatus);
            if (!isSuccess) {
              const finalRun = c.runRepository.findByUuid(out.uuid);
              printRunFailureSummary(
                out.uuid,
                finalRun?.failureReason,
                finalRun?.status ?? (out.status as RunStatus),
              );
            }
            await drainAndExit(c, isSuccess ? 0 : EXIT_USER_ERROR);
            return;
          } finally {
            signalHandlers.remove();
          }
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        await drainAndExit(containerRef, EXIT_INTERNAL_ERROR);
      }
    });

  program
    .command('worker start')
    .description('Start a standalone scheduler worker using the shared fair repository pool')
    .option(
      '--global-concurrency <n>',
      'Maximum number of concurrent runs across all repositories',
      (v) => {
        const n = parseInt(v, 10);
        if (!/^\d+$/.test(v) || n < 1) {
          throw new Error('--global-concurrency must be a positive integer');
        }
        return n;
      },
    )
    .option(
      '--poll-interval-ms <n>',
      'Polling interval in milliseconds between scheduler ticks',
      (v) => {
        const n = parseInt(v, 10);
        if (!/^\d+$/.test(v) || n < 1) {
          throw new Error('--poll-interval-ms must be a positive integer');
        }
        return n;
      },
    )
    .action(async (opts: { globalConcurrency?: number; pollIntervalMs?: number }) => {
      const targetRepoRoot = findRepoRoot(process.cwd());
      const scriptPath = join(targetRepoRoot, 'scripts', 'legacy', 'ai-run-issue-v2');
      const composeOpts: ComposeOptions = {
        repoRoot: targetRepoRoot,
        scriptPath,
        runStartupSweeps: false,
        ...buildOpts?.composeOverrides,
      };
      const c = composeRoot(composeOpts);

      const mergedConfig = { ...c.schedulerConfig };
      if (opts.globalConcurrency !== undefined) {
        mergedConfig.globalConcurrency = opts.globalConcurrency;
      }
      if (opts.pollIntervalMs !== undefined) {
        mergedConfig.pollIntervalMs = opts.pollIntervalMs;
      }

      const parsed = schedulerConfigSchema.safeParse(mergedConfig);
      if (!parsed.success) {
        console.error(
          `Error: Invalid scheduler configuration: ${parsed.error.errors.map((e) => e.message).join(', ')}`,
        );
        await drainAndExit(c, EXIT_USER_ERROR);
        return;
      }

      const scheduler = getOrCreateScheduler(
        c,
        'worker',
        {
          globalConcurrency: parsed.data.globalConcurrency,
          pollIntervalMs: parsed.data.pollIntervalMs,
        },
        buildOpts,
      );
      const abortController = new AbortController();
      const workerSweepWorkerId = WorkerId(`worker-sweep-${process.pid}`);
      const sweepCoordinator = c.buildRepositorySweepCoordinator();

      const shutdownCoordinator = new ShutdownCoordinator({
        scheduler,
        runtimeCatalog: c.runtimeCatalog,
        auxiliaryTimers: [],
        shutdownGraceMs: parsed.data.shutdownGraceMs,
      });

      let isShuttingDown = false;
      let initialSweepPromise: Promise<unknown> | undefined;
      const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        abortController.abort();
        await shutdownCoordinator.shutdown(abortController.signal);
        await drainAndExit(c, 0, DEFAULT_DRAIN_TIMEOUT_MS, initialSweepPromise);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      const runInitialSweep = async () => {
        try {
          const initialResult = await sweepCoordinator.execute(workerSweepWorkerId);
          for (const repoResult of initialResult?.results ?? []) {
            if (repoResult.error) {
              console.error(`Initial sweep error for ${repoResult.fullName}: ${repoResult.error}`);
            }
            if (repoResult.orphaned) {
              const o = repoResult.orphaned;
              if (o.enqueued > 0 || o.skippedLeaseConflict > 0 || o.enqueueErrors.length > 0) {
                console.error(
                  `Orphan recovery: ${o.enqueued} enqueued, ${o.skippedLeaseConflict} skipped (lease), ${o.enqueueErrors.length} errors`,
                );
              }
            }
            if (repoResult.waiting) {
              const w = repoResult.waiting;
              if (w.reactivated > 0 || w.errors.length > 0 || w.enqueueErrors.length > 0) {
                console.error(
                  `Reactivation sweep: ${w.reactivated} reactivated, ${w.errors.length} errors, ${w.enqueueErrors.length} enqueue errors`,
                );
              }
            }
          }
          return initialResult;
        } catch (err) {
          console.error('Initial sweep error:', err instanceof Error ? err.message : String(err));
        }
      };
      initialSweepPromise = runInitialSweep();
      c.trackStartupSweep?.(initialSweepPromise);

      await initialSweepPromise;

      try {
        await scheduler.run(abortController.signal);
      } catch (err) {
        console.error('Scheduler run error:', err instanceof Error ? err.message : String(err));
        await drainAndExit(c, EXIT_INTERNAL_ERROR, DEFAULT_DRAIN_TIMEOUT_MS, initialSweepPromise);
      }
    });

  program
    .command('serve')
    .description('Start the orchestrator HTTP API')
    .option('--port <port>', 'Port to listen on', (v) => parseInt(v, 10), 4319)
    .option('--host <host>', 'Host/interface to bind to (default: 127.0.0.1)', '127.0.0.1')
    .option(
      '--allow-origin <origin>',
      'Additional CORS origin to allow (repeatable, default: http://127.0.0.1:4310)',
      (val: string, prev: string[] = []) => [...prev, val],
    )
    .option('--script <path>', 'Path to Bash script to wrap')
    .option('--repo-root <path>', 'Repository root (default: auto-detect)')
    .option(
      '--db-path <path>',
      'Override database path (default: <repoRoot>/.ai-runs/orchestrator.sqlite)',
    )
    .option('--runs-dir <path>', 'Override runs directory (default: <repoRoot>/.ai-runs)')
    .option(
      '--target-repo-root <path>',
      'Target repository root for worktrees and DB (default: orchestrator repo)',
    )
    .action(
      async (opts: {
        port: number;
        host: string;
        allowOrigin?: string[];
        script?: string;
        repoRoot?: string;
        dbPath?: string;
        runsDir?: string;
        targetRepoRoot?: string;
      }) => {
        const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
          console.error(`Error: ${msg}`);
          process.exit(EXIT_USER_ERROR);
        });

        const repoRoot = opts.repoRoot ?? findRepoRoot(process.cwd());
        const scriptPath = opts.script
          ? isAbsolute(opts.script)
            ? opts.script
            : resolve(repoRoot, opts.script)
          : join(repoRoot, 'scripts', 'legacy', 'ai-run-issue-v2');
        const composeOpts: ComposeOptions = {
          repoRoot,
          scriptPath,
          runStartupSweeps: false, // NEW: disable legacy un-leased startup sweeps
          ...buildOpts?.composeOverrides,
        };
        if (opts.dbPath) composeOpts.dbPath = opts.dbPath;
        if (opts.runsDir) composeOpts.runsDir = opts.runsDir;
        if (targetRepoRoot !== undefined) composeOpts.targetRepoRoot = targetRepoRoot;
        const c = composeRoot(composeOpts);

        const scheduler = getOrCreateScheduler(c, 'serve', {}, buildOpts);
        const abortController = new AbortController();
        const serveSweepWorkerId = WorkerId(`serve-sweep-${process.pid}`);
        const sweepCoordinator = c.buildRepositorySweepCoordinator();

        let sweepTimer: { stop: () => void } | undefined;
        let isShuttingDown = false;
        let server: { stop: () => Promise<void>; address: unknown } | undefined;
        let testWorkerReaper: { stop: () => void } | undefined;

        const shutdownCoordinator = new ShutdownCoordinator({
          scheduler,
          runtimeCatalog: c.runtimeCatalog,
          server: () => server,
          auxiliaryTimers: () => [sweepTimer, testWorkerReaper],
          shutdownGraceMs: c.schedulerConfig.shutdownGraceMs,
        });

        const logSweepResult = (
          label: string,
          result: Awaited<ReturnType<typeof sweepCoordinator.execute>>,
        ) => {
          for (const repoResult of result?.results ?? []) {
            if (repoResult.error) {
              console.error(`${label} error for ${repoResult.fullName}: ${repoResult.error}`);
            }
            if (repoResult.orphaned) {
              const o = repoResult.orphaned;
              if (o.enqueued > 0 || o.skippedLeaseConflict > 0 || o.enqueueErrors.length > 0) {
                console.error(
                  `Orphan recovery: ${o.enqueued} enqueued, ${o.skippedLeaseConflict} skipped (lease), ${o.enqueueErrors.length} errors`,
                );
              }
            }
            if (repoResult.waiting) {
              const w = repoResult.waiting;
              if (w.reactivated > 0 || w.errors.length > 0 || w.enqueueErrors.length > 0) {
                console.error(
                  `Reactivation sweep: ${w.reactivated} reactivated, ${w.errors.length} errors, ${w.enqueueErrors.length} enqueue errors`,
                );
              }
            }
          }
        };

        let initialSweepPromise: Promise<unknown> | undefined;

        const shutdown = async () => {
          if (isShuttingDown) return;
          isShuttingDown = true;
          abortController.abort();
          await shutdownCoordinator.shutdown(abortController.signal);
          await drainAndExit(c, 0, DEFAULT_DRAIN_TIMEOUT_MS, initialSweepPromise);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        // Recovery precedes admission: the initial repository sweep must complete
        // (successfully or not) before the HTTP API starts serving and the scheduler
        // begins admitting new work. This runs detached from the command action so
        // that `serve` returns promptly and shutdown signals registered above can
        // still be handled while recovery is in flight.
        const runInitialSweep = async () => {
          try {
            const initialResult = await sweepCoordinator.execute(serveSweepWorkerId);
            logSweepResult('Initial sweep', initialResult);
          } catch (err) {
            console.error('Initial sweep error:', err instanceof Error ? err.message : String(err));
          }
        };
        initialSweepPromise = runInitialSweep();
        c.trackStartupSweep?.(initialSweepPromise);

        void (async () => {
          await initialSweepPromise;

          if (isShuttingDown) return;

          const { startServer } = await import('./server.js');
          const corsOrigins = ['http://127.0.0.1:4310', ...(opts.allowOrigin ?? [])];
          server = await startServer({
            container: c,
            port: opts.port,
            host: opts.host,
            corsOrigins,
          });
          const addr = server.address as { port: number };
          console.error(`orchestrator API listening on http://${opts.host}:${addr.port}`);
          testWorkerReaper = startTestWorkerReaper(c.reapOrphanedTestWorkers);

          if (isShuttingDown) return;

          scheduler.run(abortController.signal).catch((err) => {
            console.error('Scheduler run error:', err instanceof Error ? err.message : String(err));
          });

          if (c.serveSweepIntervalSeconds > 0 && !isShuttingDown) {
            const MIN_SWEEP_INTERVAL_MS = 30_000;
            const intervalMs = Math.max(c.serveSweepIntervalSeconds * 1000, MIN_SWEEP_INTERVAL_MS);
            let isRunning = false;
            const timer = setInterval(async () => {
              if (isRunning || isShuttingDown) return;
              isRunning = true;
              try {
                const result = await sweepCoordinator.execute(serveSweepWorkerId);
                logSweepResult('Sweep', result);
              } catch (err) {
                console.error('Periodic sweep error:', err);
              } finally {
                isRunning = false;
              }
            }, intervalMs);
            sweepTimer = { stop: () => clearInterval(timer) };
          }
        })();
      },
    );

  program
    .command('seed-test-db')
    .description('Seed the test database for e2e tests')
    .requiredOption('--db-path <path>', 'Path to the SQLite database file')
    .requiredOption('--runs-dir <path>', 'Path to the runs directory')
    .action(async (opts: { dbPath: string; runsDir: string }) => {
      try {
        seedTestDatabase(opts.dbPath, opts.runsDir);
        process.exit(0);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  program
    .command('runs')
    .description('Manage orchestrator runs')
    .addCommand(
      new Command('cancel')
        .description('Cancel an active run')
        .option('--repository-id <id|owner/name>', 'Repository ID or owner/name')
        .option('--issue <number>', 'Issue number', (v) => {
          if (!/^\d+$/.test(v)) throw new Error(`--issue must be a positive integer, got: ${v}`);
          const n = parseInt(v, 10);
          if (n < 1) throw new Error(`--issue must be >= 1, got: ${v}`);
          return n;
        })
        .option('--uuid <uuid>', 'Run UUID')
        .option('--reason <string>', 'Cancellation reason')
        .option(
          '--target-repo-root <path>',
          'Target repository root for runs DB and worktrees (default: orchestrator repo)',
        )
        .action(
          async (opts: {
            issue?: number;
            uuid?: string;
            reason?: string;
            targetRepoRoot?: string;
            repositoryId?: string;
          }) => {
            if (!opts.issue && !opts.uuid) {
              console.error('Error: specify --issue or --uuid');
              await drainAndExit(undefined, EXIT_USER_ERROR);
              return;
            }
            if (opts.issue && opts.uuid) {
              console.error('Error: specify --issue or --uuid, not both');
              await drainAndExit(undefined, EXIT_USER_ERROR);
              return;
            }
            let containerRef: Container | undefined;
            try {
              const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
                console.error(`Error: ${msg}`);
                process.exit(EXIT_USER_ERROR);
              });
              const { c } = composeWithTarget(targetRepoRoot, {
                ...(buildOpts !== undefined ? { buildOpts } : {}),
              });
              containerRef = c;
              const callerRepoId = resolveRepoIdForCli({ repositoryId: opts.repositoryId }, c);
              let uuid: string;
              if (opts.uuid) {
                uuid = opts.uuid;
              } else {
                const repoId = callerRepoId
                  ? (callerRepoId as RepositoryId)
                  : c.repoFullName
                    ? RepositoryId(c.repoFullName)
                    : undefined;
                if (!repoId) {
                  console.error('Error: could not determine repository name.');
                  await drainAndExit(c, EXIT_USER_ERROR);
                  return;
                }
                const run = c.runRepository.findByIssueNumber(repoId, opts.issue!);
                if (!run) {
                  console.error(`No run found for issue ${opts.issue}`);
                  await drainAndExit(c, EXIT_USER_ERROR);
                  return;
                }
                uuid = run.uuid;
              }
              const run = c.runRepository.findByUuid(uuid);
              if (!run) {
                throw new Error(`No run found for uuid ${uuid}`);
              }
              if (callerRepoId) {
                c.loadRepositoryForRun.execute({
                  run,
                  callerRepoId: callerRepoId as RepositoryId,
                  strictMatch: false,
                });
              }
              const pid = run.pid;
              if (pid !== undefined && pid !== null && pid !== process.pid) {
                try {
                  process.kill(pid, 'SIGTERM');
                } catch (killErr: unknown) {
                  const code = (killErr as NodeJS.ErrnoException).code;
                  if (code === 'EPERM') {
                    console.error(
                      `Warning: could not signal PID ${pid} (permission denied). The process may still be running.`,
                    );
                  }
                }
              }
              const cancelResult = await c.cancelRun.execute({
                runId: RunId(uuid),
                ...(opts.reason ? { reason: opts.reason } : {}),
              });
              if (cancelResult.abortStatus === 'timed_out') {
                process.stdout.write(
                  'Run cancelled, but process abort timed out. Worktree was NOT reset because the process may still be running.\n',
                );
              } else if (cancelResult.branchSha) {
                process.stdout.write(
                  `Run cancelled successfully (branch left at ${cancelResult.branchSha})\n`,
                );
              } else {
                process.stdout.write('Run cancelled successfully\n');
              }
              const isCliTestSuite =
                buildOpts?.isCliTestSuite ?? process.env.AI_CLI_TEST_SUITE === 'true';
              if (!isCliTestSuite) {
                await drainAndExit(c, 0);
              } else {
                await c.drainStartupSweeps?.(DEFAULT_DRAIN_TIMEOUT_MS);
                await c.runNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
              }
            } catch (err) {
              console.error(err instanceof Error ? err.message : String(err));
              await drainAndExit(containerRef, EXIT_USER_ERROR);
            }
          },
        ),
    )
    .addCommand(
      new Command('check-merge-ready')
        .alias('check-merge-readiness')
        .description('Verify that a run has no unverified or blocked review comments')
        .requiredOption('--uuid <uuid>', 'Run UUID')
        .option('--repository-id <id|owner/name>', 'Repository ID or owner/name')
        .option(
          '--target-repo-root <path>',
          'Target repository root for runs DB and worktrees (default: orchestrator repo)',
        )
        .action(async (opts: { uuid: string; targetRepoRoot?: string; repositoryId?: string }) => {
          let containerRef: Container | undefined;
          try {
            const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
              console.error(`Error: ${msg}`);
              process.exit(EXIT_USER_ERROR);
            });
            const { c } = composeWithTarget(targetRepoRoot, {
              ...(buildOpts !== undefined ? { buildOpts } : {}),
            });
            containerRef = c;
            const callerRepoId = resolveRepoIdForCli({ repositoryId: opts.repositoryId }, c);
            // An unknown UUID must fail, not report ready: listComments on a
            // nonexistent run returns no rows, which would green-light the merge.
            const run = c.runRepository.findByUuid(opts.uuid);
            if (!run) {
              console.error(`No run found for uuid ${opts.uuid}`);
              await drainAndExit(c, EXIT_USER_ERROR);
              return;
            }
            if (callerRepoId) {
              c.loadRepositoryForRun.execute({
                run,
                callerRepoId: callerRepoId as RepositoryId,
                strictMatch: false,
              });
            }
            const result = await c.checkMergeReadiness.execute(RunId(opts.uuid));
            process.stdout.write(JSON.stringify(result, null, 2) + '\n');
            if (!result.isReady) {
              console.error(`Error: PR is not ready for merge: ${result.reason}`);
              await drainAndExit(c, EXIT_USER_ERROR);
              return;
            }
            console.error('Success: PR is ready for merge.');
            await drainAndExit(c, 0);
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            await drainAndExit(containerRef, EXIT_USER_ERROR);
          }
        }),
    )
    .addCommand(
      new Command('execute')
        .description('Execute a queued run through the RunExecutor')
        .requiredOption('--uuid <uuid>', 'Run UUID to execute')
        .option('--repository-id <id|owner/name>', 'Repository ID or owner/name')
        .option(
          '--target-repo-root <path>',
          'Target repository root for worktrees and DB (default: orchestrator repo)',
        )
        .action(async (opts: { uuid: string; targetRepoRoot?: string; repositoryId?: string }) => {
          let containerRef: Container | undefined;
          try {
            const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
              console.error(`Error: ${msg}`);
              process.exit(EXIT_USER_ERROR);
            });
            const { c } = composeWithTarget(targetRepoRoot, {
              ...(buildOpts !== undefined ? { buildOpts } : {}),
            });
            containerRef = c;
            if (!c.runExecutor) {
              console.error(
                'Error: RunExecutor not available. Ensure agent config is present in .ai-orchestrator.json.',
              );
              await drainAndExit(c, EXIT_USER_ERROR);
              return;
            }
            const run = c.runRepository.findByUuid(opts.uuid);
            if (!run) {
              console.error(`No run found for uuid ${opts.uuid}`);
              await drainAndExit(c, EXIT_USER_ERROR);
              return;
            }
            const callerRepoId = resolveRepoIdForCli({ repositoryId: opts.repositoryId }, c);
            if (callerRepoId) {
              c.loadRepositoryForRun.execute({
                run,
                callerRepoId: callerRepoId as RepositoryId,
                strictMatch: false,
              });
            }
            if (run.status !== 'queued' && run.status !== 'running' && run.status !== 'waiting') {
              console.error(
                `Run ${opts.uuid} has status ${run.status}, expected queued, running, or waiting`,
              );
              await drainAndExit(c, EXIT_USER_ERROR);
              return;
            }
            const repoId = callerRepoId
              ? (callerRepoId as RepositoryId)
              : c.repoFullName
                ? RepositoryId(c.repoFullName)
                : undefined;
            if (!repoId) {
              console.error('Error: could not determine repository name.');
              await drainAndExit(c, EXIT_USER_ERROR);
              return;
            }
            const workerId = WorkerId(`cli-${process.pid}`);
            const leaseTtlMs = buildOpts?.lease?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
            const heartbeatIntervalMs =
              buildOpts?.lease?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
            let acquiredLease;
            try {
              acquiredLease = c.workerLeaseRepository.acquire({
                repoId,
                workerId,
                runId: RunId(opts.uuid),
                now: new Date(),
                ttlMs: leaseTtlMs,
              });
            } catch (err) {
              if (err instanceof WorkerLeaseConflictError) {
                console.error(
                  `Error: repository ${repoId} already has an active lease. Another run is in progress.`,
                );
                await drainAndExit(c, EXIT_USER_ERROR);
                return;
              }
              throw new Error(`Failed to acquire worker lease: ${(err as Error).message}`);
            }

            // For waiting runs, transition back to running so the executor
            // re-enters post-pr-review (the poller will find new comments).
            if (run.status === 'waiting') {
              c.runRepository.update(run.uuid, { status: 'running' });
            }
            c.runRepository.update(run.uuid, { pid: process.pid });

            let signalHandlers: { remove: () => void } | undefined;
            let lease: { stop: () => void } | undefined;
            let testWorkerReaper: { stop: () => void } | undefined;
            const releaseLeaseOnSignal = async () => {
              try {
                testWorkerReaper?.stop();
                c.workerLeaseRepository.release({
                  repoId,
                  workerId,
                  runId: RunId(run.uuid),
                  leaseToken: acquiredLease.leaseToken,
                });
              } catch (err) {
                console.error(
                  `Failed to release lease on exit: ${(err as Error)?.message ?? String(err)}`,
                );
              }
              try {
                await c.drainStartupSweeps?.(DEFAULT_DRAIN_TIMEOUT_MS);
              } catch {}
              try {
                await c.runNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
              } catch {}
            };
            try {
              signalHandlers = installSignalHandlers(
                c.runRepository,
                repoId,
                run.issueNumber,
                releaseLeaseOnSignal,
                (exitCode) => drainAndExit(c, exitCode),
              );
              lease = startLeaseHeartbeat(
                c.workerLeaseRepository,
                repoId,
                workerId,
                RunId(run.uuid),
                acquiredLease.leaseToken,
                leaseTtlMs,
                heartbeatIntervalMs,
                (code) => drainAndExit(c, code),
              );
              testWorkerReaper = startTestWorkerReaper(c.reapOrphanedTestWorkers);
              // The executor auto-skips phases in run.completedPhases, so passing
              // skip:[] is correct — the run resumes at post-pr-review naturally.
              const result = await c.runExecutor.execute({
                run: { ...run, status: 'running' },
                skip: [],
                presentArtifacts: [],
              });
              process.stdout.write(
                JSON.stringify({
                  run: result.run,
                  phases: result.phases,
                }) + '\n',
              );
            } finally {
              testWorkerReaper?.stop();
              signalHandlers?.remove();
              lease?.stop();
            }
            const isCliTestSuite =
              buildOpts?.isCliTestSuite ?? process.env.AI_CLI_TEST_SUITE === 'true';
            if (!isCliTestSuite) {
              await drainAndExit(containerRef, 0);
            } else {
              await containerRef?.drainStartupSweeps?.(DEFAULT_DRAIN_TIMEOUT_MS);
              await containerRef?.runNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
            }
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            await drainAndExit(containerRef, EXIT_USER_ERROR);
          }
        }),
    )
    .addCommand(
      new Command('resume')
        .alias('retry')
        .description('Resume a failed or blocked run')
        .requiredOption('--uuid <uuid>', 'Run UUID')
        .option('--repository-id <id|owner/name>', 'Repository ID or owner/name')
        .option(
          '--from-phase <phase>',
          'Phase to resume from (default: auto-detect failed or blocked phase)',
        )
        .option(
          '--disposition <mode>',
          'Resume disposition: preserve_working_tree | reset_to_baseline',
        )
        .option('--confirm', 'Confirm retry/resume of an unsafe phase')
        .option('--verbose', 'Stream progress to terminal (default: auto when TTY)')
        .option('--no-verbose', 'Suppress streaming progress to terminal')
        .option(
          '--target-repo-root <path>',
          'Target repository root for runs DB and worktrees (default: orchestrator repo)',
        )
        .option(
          '--allow-protected-path <path>',
          'Allow modifying protected path in create-pr guard (repeatable)',
          (val: string, prev: string[] = []) => [...prev, val],
        )
        .action(
          async (opts: {
            uuid: string;
            fromPhase?: string;
            confirm?: boolean;
            verbose?: boolean;
            targetRepoRoot?: string;
            repositoryId?: string;
            disposition?: string;
            allowProtectedPath?: string[];
          }) => {
            const isCliTestSuite =
              buildOpts?.isCliTestSuite ?? process.env.AI_CLI_TEST_SUITE === 'true';
            const bypassPlanValidation =
              buildOpts?.bypassPlanValidation ??
              (isCliTestSuite || process.env.AI_BYPASS_PLAN_VALIDATION === 'true');
            let containerRef: Container | undefined;
            try {
              const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
                console.error(`Error: ${msg}`);
                process.exit(EXIT_USER_ERROR);
              });
              const { c } = composeWithTarget(targetRepoRoot, {
                ...(buildOpts !== undefined ? { buildOpts } : {}),
                composeOverrides: {
                  ...(opts.allowProtectedPath !== undefined
                    ? { allowProtectedPaths: opts.allowProtectedPath }
                    : {}),
                },
              });
              containerRef = c;

              if (opts.disposition !== undefined) {
                if (
                  opts.disposition !== 'preserve_working_tree' &&
                  opts.disposition !== 'reset_to_baseline'
                ) {
                  console.error(
                    'Error: invalid --disposition. Must be preserve_working_tree or reset_to_baseline.',
                  );
                  await drainAndExit(c, EXIT_USER_ERROR);
                  return;
                }
              }
              if (!c.runExecutor) {
                console.error(
                  'Error: RunExecutor not available. Ensure agent config is present in .ai-orchestrator.json.',
                );
                await drainAndExit(c, EXIT_USER_ERROR);
                return;
              }
              const run = c.runRepository.findByUuid(opts.uuid);
              if (!run) {
                console.error(`No run found for uuid ${opts.uuid}`);
                await drainAndExit(c, EXIT_USER_ERROR);
                return;
              }
              const callerRepoId = resolveRepoIdForCli({ repositoryId: opts.repositoryId }, c);
              if (callerRepoId) {
                c.loadRepositoryForRun.execute({
                  run,
                  callerRepoId: callerRepoId as RepositoryId,
                  strictMatch: false,
                });
              }

              let phases = c.phaseRepository.listByRun(opts.uuid);
              let reconciledRun = run;
              if (run.status === 'running') {
                const reconciler = new SweepOrphanedRuns({
                  runRepository: c.runRepository,
                  phaseRepository: c.phaseRepository,
                  isProcessAlive: checkPid,
                  now: () => new Date(),
                  runNotification: c.runNotification,
                });
                const entry = reconciler.reconcile(run);
                if (entry) {
                  const refreshedRun = c.runRepository.findByUuid(opts.uuid);
                  if (!refreshedRun) {
                    console.error(`Error: run ${opts.uuid} not found after reconciliation.`);
                    await drainAndExit(c, EXIT_INTERNAL_ERROR);
                    return;
                  }
                  reconciledRun = refreshedRun;
                  phases = c.phaseRepository.listByRun(opts.uuid);
                }
              }

              const plan = planRunRecoveryAction({
                action: opts.fromPhase ? 'resume' : 'retry',
                run: reconciledRun,
                phases,
                ...(opts.fromPhase ? { fromPhase: opts.fromPhase } : {}),
              });

              if (!bypassPlanValidation) {
                if (!plan.allowed) {
                  console.error(plan.denialReason || 'Action not allowed');
                  await drainAndExit(c, EXIT_USER_ERROR);
                  return;
                }

                if (plan.requiresConfirmation && !opts.confirm) {
                  console.error(
                    'Retrying this phase can duplicate side effects. Re-run with --confirm to continue.',
                  );
                  await drainAndExit(c, EXIT_USER_ERROR);
                  return;
                }
              }

              const repoId = callerRepoId
                ? (callerRepoId as RepositoryId)
                : c.repoFullName
                  ? RepositoryId(c.repoFullName)
                  : undefined;
              if (!repoId) {
                console.error('Error: could not determine repository name.');
                await drainAndExit(c, EXIT_USER_ERROR);
                return;
              }
              const runPolicy = (reconciledRun.executionPolicy ?? 'standard').toUpperCase();
              const resumePhase =
                plan.targetPhase ?? opts.fromPhase ?? reconciledRun.currentPhase ?? 'auto';
              const effectivePhases = resolvePhaseOrder(reconciledRun.executionPolicy);
              console.error(`Execution policy: ${runPolicy}`);
              console.error(`Resuming from phase: ${resumePhase}`);
              console.error('Phase graph:');
              for (const p of effectivePhases) {
                console.error(`  ${p}`);
              }

              const workerId = WorkerId(`cli-${process.pid}`);

              const leaseTtlMs = buildOpts?.lease?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
              const heartbeatIntervalMs =
                buildOpts?.lease?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

              const didReconcile = reconciledRun !== run;
              if (didReconcile) {
                const existingLease = c.workerLeaseRepository.current(repoId);
                if (existingLease && existingLease.runId === opts.uuid) {
                  c.workerLeaseRepository.release({
                    repoId,
                    workerId: existingLease.workerId,
                    runId: existingLease.runId,
                    leaseToken: existingLease.leaseToken,
                  });
                }
              }

              let acquiredLease;
              try {
                acquiredLease = c.workerLeaseRepository.acquire({
                  repoId,
                  workerId,
                  runId: RunId(opts.uuid),
                  now: new Date(),
                  ttlMs: leaseTtlMs,
                });
              } catch (err) {
                if (err instanceof WorkerLeaseConflictError) {
                  console.error(
                    `Error: repository ${repoId} already has an active lease. Another run is in progress.`,
                  );
                  await drainAndExit(c, EXIT_USER_ERROR);
                  return;
                }
                throw new Error(`Failed to acquire worker lease: ${(err as Error).message}`);
              }

              c.runRepository.update(run.uuid, { pid: process.pid });

              let signalHandlers: { remove: () => void } | undefined;
              let lease: { stop: () => void } | undefined;
              let testWorkerReaper: { stop: () => void } | undefined;
              const releaseLeaseOnSignal = async () => {
                try {
                  testWorkerReaper?.stop();
                  c.workerLeaseRepository.release({
                    repoId,
                    workerId,
                    runId: RunId(run.uuid),
                    leaseToken: acquiredLease.leaseToken,
                  });
                } catch (err) {
                  console.error(
                    `Failed to release lease on exit: ${(err as Error)?.message ?? String(err)}`,
                  );
                }
                try {
                  await c.drainStartupSweeps?.(DEFAULT_DRAIN_TIMEOUT_MS);
                } catch {}
                try {
                  await c.runNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
                } catch {}
              };

              let unsubscribe: (() => void) | undefined;
              const tee = opts.verbose ?? Boolean(process.stdout.isTTY);
              if (tee) {
                unsubscribe = c.eventBus.subscribe(RunId(opts.uuid), (event) => {
                  if (shouldStreamEventToCli(event)) {
                    console.error(`[ts] ${event.message}`);
                  }
                });
              }

              try {
                signalHandlers = installSignalHandlers(
                  c.runRepository,
                  repoId,
                  run.issueNumber,
                  releaseLeaseOnSignal,
                  (exitCode) => drainAndExit(c, exitCode),
                );
                lease = startLeaseHeartbeat(
                  c.workerLeaseRepository,
                  repoId,
                  workerId,
                  RunId(run.uuid),
                  acquiredLease.leaseToken,
                  leaseTtlMs,
                  heartbeatIntervalMs,
                  (code) => drainAndExit(c, code),
                );
                testWorkerReaper = startTestWorkerReaper(c.reapOrphanedTestWorkers);

                let effectiveDisposition: ResumeDisposition = 'reset_to_baseline';
                if (opts.fromPhase) {
                  const transitionState = await c.resumeRun.transition({
                    runId: RunId(opts.uuid),
                    fromPhase: plan.targetPhase ?? opts.fromPhase,
                    workerId,
                    ...(plan.attempt !== undefined ? { attempt: plan.attempt } : {}),
                    ...(opts.disposition
                      ? { resumeDisposition: opts.disposition as ResumeDisposition }
                      : {}),
                  });
                  effectiveDisposition = transitionState.effectiveDisposition;
                } else {
                  const transitionState = await c.retryFailedPhase.execute({
                    runId: RunId(opts.uuid),
                    workerId,
                    ...(opts.disposition
                      ? { resumeDisposition: opts.disposition as ResumeDisposition }
                      : {}),
                  });
                  if (
                    transitionState &&
                    (transitionState as unknown as { effectiveDisposition?: ResumeDisposition })
                      .effectiveDisposition
                  ) {
                    effectiveDisposition = (
                      transitionState as unknown as { effectiveDisposition: ResumeDisposition }
                    ).effectiveDisposition;
                  }
                }

                const updatedRun = c.runRepository.findByUuid(opts.uuid);
                if (!updatedRun) {
                  console.error(`Error: run ${opts.uuid} not found after transition.`);
                  await drainAndExit(c, EXIT_USER_ERROR);
                  return;
                }

                const result = await c.runExecutor.execute({
                  run: { ...updatedRun, status: 'running' },
                  skip: [],
                  presentArtifacts: [],
                  resumeDisposition: effectiveDisposition,
                  ...(opts.allowProtectedPath !== undefined
                    ? { allowProtectedPaths: opts.allowProtectedPath }
                    : {}),
                });

                process.stdout.write(
                  JSON.stringify({
                    run: result.run,
                    phases: result.phases,
                  }) + '\n',
                );
              } finally {
                testWorkerReaper?.stop();
                unsubscribe?.();
                signalHandlers?.remove();
                lease?.stop();
              }
            } catch (err) {
              console.error(err instanceof Error ? err.message : String(err));
              await drainAndExit(containerRef, EXIT_USER_ERROR);
              return;
            }
            if (!isCliTestSuite) {
              await drainAndExit(containerRef, 0);
            } else {
              await containerRef?.drainStartupSweeps?.(DEFAULT_DRAIN_TIMEOUT_MS);
              await containerRef?.runNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
            }
          },
        ),
    )
    .addCommand(
      new Command('logs')
        .description('Tail active run output')
        .requiredOption('--issue <number>', 'Issue number', (v) => {
          if (!/^\d+$/.test(v)) throw new Error(`--issue must be a positive integer, got: ${v}`);
          const n = parseInt(v, 10);
          if (n < 1) throw new Error(`--issue must be >= 1, got: ${v}`);
          return n;
        })
        .option('--follow', 'Follow new invocations as they start', true)
        .option('--no-follow', 'Do not follow new invocations')
        .option('--lines <number>', 'Initial lines to show', (v) => parseInt(v, 10), 50)
        .option(
          '--target-repo-root <path>',
          'Target repository root for runs DB and worktrees (default: orchestrator repo)',
        )
        .action(
          async (opts: {
            issue: number;
            follow: boolean;
            lines: number;
            targetRepoRoot?: string;
          }) => {
            let containerRef: Container | undefined;
            try {
              const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
                console.error(`Error: ${msg}`);
                process.exit(EXIT_USER_ERROR);
              });
              const { c } = composeWithTarget(targetRepoRoot, {
                ...(buildOpts !== undefined ? { buildOpts } : {}),
              });
              containerRef = c;
              if (!c.repoFullName) {
                console.error('Error: could not determine repository name.');
                await drainAndExit(c, EXIT_USER_ERROR);
                return;
              }
              const repoId = RepositoryId(c.repoFullName);
              let run = c.runRepository.findByIssueNumber(repoId, opts.issue);
              if (!run) {
                console.error(`No run found for issue ${opts.issue}`);
                await drainAndExit(c, EXIT_USER_ERROR);
                return;
              }

              const terminalStatuses: RunStatus[] = ['passed', 'failed', 'cancelled'];
              let currentInvocationId: string | undefined;
              let tailer: import('@ai-sdlc/application/ports').FileTailerPort | undefined;
              let currentPhase: string | undefined;

              const stopTailer = async () => {
                if (tailer) {
                  await tailer.stop();
                  tailer = undefined;
                }
              };

              process.on('SIGINT', async () => {
                await stopTailer();
                await drainAndExit(c, 0);
              });

              for (;;) {
                // Refresh run record to check status and current phase
                const updatedRun = c.runRepository.findByUuid(run.uuid);
                if (updatedRun) {
                  run = updatedRun;
                }

                if (run.currentPhase !== currentPhase) {
                  currentPhase = run.currentPhase;
                  process.stdout.write(
                    `\n--- Run ${run.displayId} | Phase: ${currentPhase ?? 'starting'} ---\n`,
                  );
                }

                const invocations = c.agentInvocationRepository.listByRun(RunId(run.uuid));
                const latestInvocation = invocations[invocations.length - 1];

                if (latestInvocation && latestInvocation.id !== currentInvocationId) {
                  // Delay advancing currentInvocationId until we have a path to tail,
                  // or handle the case where the same ID eventually gets a path.
                  if (latestInvocation.stdoutPath) {
                    const isFirstTailer = currentInvocationId === undefined;
                    await stopTailer();
                    currentInvocationId = latestInvocation.id;

                    tailer = c.createFileTailer({
                      path: latestInvocation.stdoutPath,
                      onData: (data: string) => {
                        process.stdout.write(data);
                      },
                      // If it's the very first invocation we start tailing, honor --lines.
                      // For subsequent invocations in the same run, start from the beginning.
                      ...(isFirstTailer ? { initialLines: opts.lines } : { fromStart: true }),
                    });
                    await tailer.start();
                  }
                }

                if (terminalStatuses.includes(run.status)) {
                  // Wait a bit to ensure the tailer has drained everything
                  await sleep(1000);
                  await stopTailer();
                  process.stdout.write(
                    `\n--- Run ${run.displayId} finished with status: ${run.status} ---\n`,
                  );
                  break;
                }

                if (!opts.follow && latestInvocation) {
                  // If not following, we just show what we have and exit
                  await sleep(500); // Give it a moment to read
                  await stopTailer();
                  break;
                }

                await sleep(1000);
              }
              const isCliTestSuite =
                buildOpts?.isCliTestSuite ?? process.env.AI_CLI_TEST_SUITE === 'true';
              if (!isCliTestSuite) {
                await drainAndExit(containerRef, 0);
              } else {
                await containerRef?.drainStartupSweeps?.(DEFAULT_DRAIN_TIMEOUT_MS);
                await containerRef?.runNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
              }
            } catch (err) {
              console.error(err instanceof Error ? err.message : String(err));
              await drainAndExit(containerRef, EXIT_USER_ERROR);
            }
          },
        ),
    );

  program
    .command('release-batch')
    .alias('releases')
    .description('Manage autonomous release batches')
    .addCommand(
      new Command('start')
        .description('Start a release batch from an explicit ordered issue list')
        .requiredOption(
          '--issues <numbers>',
          'Comma-separated ordered GitHub issue numbers (e.g. 101,102,103)',
        )
        .option('--repository-id <id|owner/name>', 'Repository ID or owner/name')
        .option(
          '--source-branch <branch>',
          'Source branch (default: target repository default branch)',
        )
        .option(
          '--release-branch <branch>',
          'Release branch name (otherwise deterministically generated)',
        )
        .option('-i, --id <id>', 'Optional release batch ID (alias for --batch-id)')
        .option('--batch-id <id>', 'Optional release batch ID')
        .option(
          '--execution-policy <policy>',
          'Execution policy: standard | strict | legacy',
          'standard',
        )
        .option(
          '--target-repo-root <path>',
          'Target repository root for runs DB and worktrees (default: orchestrator repo)',
        )
        .action(
          async (opts: {
            issues: string;
            repositoryId?: string;
            sourceBranch?: string;
            releaseBranch?: string;
            id?: string;
            batchId?: string;
            executionPolicy?: string;
            targetRepoRoot?: string;
          }) => {
            let containerRef: Container | undefined;
            try {
              const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
                console.error(`Error: ${msg}`);
                process.exit(EXIT_USER_ERROR);
              });
              const { c } = composeWithTarget(targetRepoRoot, {
                ...(buildOpts !== undefined ? { buildOpts } : {}),
                runStartupSweeps: false,
              });
              containerRef = c;

              if (!opts.issues) {
                console.error('Error: --issues is required');
                await drainAndExit(c, EXIT_USER_ERROR);
                return;
              }

              const rawIssues = opts.issues
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
              if (rawIssues.length === 0) {
                console.error(
                  'Error: --issues must specify at least one positive integer issue number',
                );
                await drainAndExit(c, EXIT_USER_ERROR);
                return;
              }

              const issueNumbers: number[] = [];
              for (const raw of rawIssues) {
                if (!/^\d+$/.test(raw)) {
                  console.error(`Error: invalid issue number "${raw}": must be a positive integer`);
                  await drainAndExit(c, EXIT_USER_ERROR);
                  return;
                }
                const n = parseInt(raw, 10);
                if (n < 1) {
                  console.error(`Error: invalid issue number "${raw}": must be >= 1`);
                  await drainAndExit(c, EXIT_USER_ERROR);
                  return;
                }
                issueNumbers.push(n);
              }

              let executionPolicy: ExecutionPolicy = 'standard';
              if (opts.executionPolicy) {
                if (!(EXECUTION_POLICIES as readonly string[]).includes(opts.executionPolicy)) {
                  console.error(
                    `Error: --execution-policy must be "standard" or "strict", got "${opts.executionPolicy}"`,
                  );
                  await drainAndExit(c, EXIT_USER_ERROR);
                  return;
                }
                executionPolicy = opts.executionPolicy as ExecutionPolicy;
              }

              const callerRepoId = resolveRepoIdForCli({ repositoryId: opts.repositoryId }, c);
              const repoId = callerRepoId
                ? (callerRepoId as RepositoryId)
                : c.repoFullName
                  ? RepositoryId(c.repoFullName)
                  : undefined;

              const chosenBatchId = opts.id ?? opts.batchId;
              const result = await c.startReleaseBatch.execute({
                repoId,
                issueNumbers,
                sourceBranch: opts.sourceBranch,
                releaseBranch: opts.releaseBranch,
                batchId: chosenBatchId ? ReleaseBatchId(chosenBatchId) : undefined,
                executionPolicy,
              });

              const outputLines = [
                `Release batch ${result.batchId} created successfully:`,
                `  Release Branch: ${result.releaseBranch}`,
                `  Source Branch:  ${result.sourceBranch} (${result.sourceStartSha})`,
                `  Issues (${result.batch.items.length}):    ${result.batch.items.map((i: { issueNumber: number }) => `#${i.issueNumber}`).join(', ')}`,
                `  Admitted Item:  #${result.batch.items[0]?.issueNumber} (Run UUID: ${result.runUuid})`,
                `  Initial Job ID: ${result.jobId}`,
              ];
              await new Promise<void>((resolve, reject) =>
                process.stdout.write(outputLines.join('\n') + '\n', (err) =>
                  err ? reject(err) : resolve(),
                ),
              );

              const isCliTestSuite =
                buildOpts?.isCliTestSuite ?? process.env.AI_CLI_TEST_SUITE === 'true';
              if (!isCliTestSuite) {
                await drainAndExit(c, 0);
              } else {
                await c.drainStartupSweeps?.(DEFAULT_DRAIN_TIMEOUT_MS);
                await c.runNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
                await c.releaseBatchNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
              }
            } catch (err) {
              console.error(err instanceof Error ? err.message : String(err));
              await drainAndExit(containerRef, EXIT_USER_ERROR);
            }
          },
        ),
    )
    .addCommand(
      new Command('status')
        .description(
          'Inspect detailed status, blocker classification, and recovery guidance for a release batch',
        )
        .option('-i, --id <id>', 'Release batch ID (alias for --batch-id)')
        .option('--batch-id <id>', 'Release batch ID')
        .option('--json', 'Output full status object as JSON')
        .option(
          '--target-repo-root <path>',
          'Target repository root for runs DB and worktrees (default: orchestrator repo)',
        )
        .action(
          async (opts: {
            id?: string;
            batchId?: string;
            json?: boolean;
            targetRepoRoot?: string;
          }) => {
            let containerRef: Container | undefined;
            try {
              const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
                console.error(`Error: ${msg}`);
                process.exit(EXIT_USER_ERROR);
              });
              const { c } = composeWithTarget(targetRepoRoot, {
                ...(buildOpts !== undefined ? { buildOpts } : {}),
                runStartupSweeps: false,
              });
              containerRef = c;

              const batchId = opts.id ?? opts.batchId;
              if (!batchId) {
                console.error('Error: --batch-id (or -i, --id) is required');
                await drainAndExit(c, EXIT_USER_ERROR);
                return;
              }

              const status = await c.getReleaseBatchStatus.execute({
                batchId: ReleaseBatchId(batchId),
              });

              if (opts.json) {
                await new Promise<void>((resolve, reject) =>
                  process.stdout.write(JSON.stringify(status, null, 2) + '\n', (err) =>
                    err ? reject(err) : resolve(),
                  ),
                );
              } else {
                await new Promise<void>((resolve, reject) =>
                  process.stdout.write(status.formattedLines.join('\n') + '\n', (err) =>
                    err ? reject(err) : resolve(),
                  ),
                );
              }

              const isCliTestSuite =
                buildOpts?.isCliTestSuite ?? process.env.AI_CLI_TEST_SUITE === 'true';
              if (!isCliTestSuite) {
                await drainAndExit(c, 0);
              } else {
                await c.drainStartupSweeps?.(DEFAULT_DRAIN_TIMEOUT_MS);
                await c.runNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
                await c.releaseBatchNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
              }
            } catch (err) {
              console.error(err instanceof Error ? err.message : String(err));
              await drainAndExit(containerRef, EXIT_USER_ERROR);
            }
          },
        ),
    )
    .addCommand(
      new Command('resume')
        .description(
          'Resume or reconcile a blocked release batch (fails closed on Run-owned blockers)',
        )
        .option('-i, --id <id>', 'Release batch ID (alias for --batch-id)')
        .option('--batch-id <id>', 'Release batch ID')
        .option('--confirm', 'Confirm resuming the release batch')
        .option(
          '--target-repo-root <path>',
          'Target repository root for runs DB and worktrees (default: orchestrator repo)',
        )
        .action(
          async (opts: {
            id?: string;
            batchId?: string;
            confirm?: boolean;
            targetRepoRoot?: string;
          }) => {
            let containerRef: Container | undefined;
            try {
              const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
                console.error(`Error: ${msg}`);
                process.exit(EXIT_USER_ERROR);
              });
              const { c } = composeWithTarget(targetRepoRoot, {
                ...(buildOpts !== undefined ? { buildOpts } : {}),
                runStartupSweeps: false,
              });
              containerRef = c;

              const batchId = opts.id ?? opts.batchId;
              if (!batchId) {
                console.error('Error: --batch-id (or -i, --id) is required');
                await drainAndExit(c, EXIT_USER_ERROR);
                return;
              }

              try {
                const result = await c.resumeReleaseBatch.execute({
                  batchId: ReleaseBatchId(batchId),
                });

                const outputLines = [
                  `Release batch ${result.batch.id} resumed:`,
                  `  Status:  ${result.batch.status}`,
                  `  Actions: ${result.actions.length > 0 ? result.actions.join(', ') : 'none'}`,
                  `  Blocker: ${result.blocker.owner !== 'none' ? `${result.blocker.owner}: ${result.blocker.reason}` : 'none'}`,
                ];
                await new Promise<void>((resolve, reject) =>
                  process.stdout.write(outputLines.join('\n') + '\n', (err) =>
                    err ? reject(err) : resolve(),
                  ),
                );

                const isCliTestSuite =
                  buildOpts?.isCliTestSuite ?? process.env.AI_CLI_TEST_SUITE === 'true';
                if (!isCliTestSuite) {
                  await drainAndExit(c, 0);
                } else {
                  await c.drainStartupSweeps?.(DEFAULT_DRAIN_TIMEOUT_MS);
                  await c.runNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
                  await c.releaseBatchNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
                }
              } catch (resumeErr) {
                if (resumeErr instanceof RunOwnedBlockerError) {
                  console.error(
                    `Error: Release batch ${resumeErr.batchId}${resumeErr.issueNumber !== undefined ? ` item #${resumeErr.issueNumber}` : ''} is blocked by run ${resumeErr.runUuid} (${resumeErr.runStatus}${resumeErr.runPhase ? ` / ${resumeErr.runPhase}` : ''}).\n` +
                      `Run recovery must be performed via Run CLI:\n` +
                      `  runs resume --uuid ${resumeErr.runUuid}`,
                  );
                  await drainAndExit(c, EXIT_USER_ERROR);
                  return;
                }
                throw resumeErr;
              }
            } catch (err) {
              console.error(err instanceof Error ? err.message : String(err));
              await drainAndExit(containerRef, EXIT_USER_ERROR);
            }
          },
        ),
    )
    .addCommand(
      new Command('approve')
        .description('Approve candidate SHA for an autonomous release batch')
        .option('-i, --id <id>', 'Release batch ID (alias for --batch-id)')
        .option('--batch-id <id>', 'Release batch ID')
        .requiredOption('--candidate-sha <sha>', 'Candidate commit SHA to approve')
        .option('--operator <name>', 'Operator identifier')
        .option('--confirm', 'Confirm candidate approval')
        .option(
          '--target-repo-root <path>',
          'Target repository root for runs DB and worktrees (default: orchestrator repo)',
        )
        .action(
          async (opts: {
            id?: string;
            batchId?: string;
            candidateSha: string;
            operator?: string;
            confirm?: boolean;
            targetRepoRoot?: string;
          }) => {
            let containerRef: Container | undefined;
            try {
              const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
                console.error(`Error: ${msg}`);
                process.exit(EXIT_USER_ERROR);
              });
              const { c } = composeWithTarget(targetRepoRoot, {
                ...(buildOpts !== undefined ? { buildOpts } : {}),
                runStartupSweeps: false,
              });
              containerRef = c;

              const batchId = opts.id ?? opts.batchId;
              if (!batchId) {
                console.error('Error: --batch-id (or -i, --id) is required');
                await drainAndExit(c, EXIT_USER_ERROR);
                return;
              }

              const operator =
                opts.operator ?? process.env.AI_SDLC_OPERATOR ?? os.userInfo().username;
              const batch = await c.approveReleaseBatchCandidate.execute({
                batchId: ReleaseBatchId(batchId),
                candidateSha: opts.candidateSha,
                operator,
              });

              const outputLines = [
                `Release batch ${batch.id} candidate ${batch.candidateSha} approved successfully:`,
                `  Status:   ${batch.status}`,
                `  Operator: ${operator}`,
              ];
              await new Promise<void>((resolve, reject) =>
                process.stdout.write(outputLines.join('\n') + '\n', (err) =>
                  err ? reject(err) : resolve(),
                ),
              );

              const isCliTestSuite =
                buildOpts?.isCliTestSuite ?? process.env.AI_CLI_TEST_SUITE === 'true';
              if (!isCliTestSuite) {
                await drainAndExit(c, 0);
              } else {
                await c.drainStartupSweeps?.(DEFAULT_DRAIN_TIMEOUT_MS);
                await c.runNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
                await c.releaseBatchNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
              }
            } catch (err) {
              console.error(err instanceof Error ? err.message : String(err));
              await drainAndExit(containerRef, EXIT_USER_ERROR);
            }
          },
        ),
    )
    .addCommand(
      new Command('reject')
        .description('Reject candidate SHA for an autonomous release batch')
        .option('-i, --id <id>', 'Release batch ID (alias for --batch-id)')
        .option('--batch-id <id>', 'Release batch ID')
        .requiredOption('--candidate-sha <sha>', 'Candidate commit SHA to reject')
        .option('--reason <reason>', 'Rejection reason')
        .option('--operator <name>', 'Operator identifier')
        .option('--confirm', 'Confirm candidate rejection')
        .option(
          '--target-repo-root <path>',
          'Target repository root for runs DB and worktrees (default: orchestrator repo)',
        )
        .action(
          async (opts: {
            id?: string;
            batchId?: string;
            candidateSha: string;
            reason?: string;
            operator?: string;
            confirm?: boolean;
            targetRepoRoot?: string;
          }) => {
            let containerRef: Container | undefined;
            try {
              const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
                console.error(`Error: ${msg}`);
                process.exit(EXIT_USER_ERROR);
              });
              const { c } = composeWithTarget(targetRepoRoot, {
                ...(buildOpts !== undefined ? { buildOpts } : {}),
                runStartupSweeps: false,
              });
              containerRef = c;

              const batchId = opts.id ?? opts.batchId;
              if (!batchId) {
                console.error('Error: --batch-id (or -i, --id) is required');
                await drainAndExit(c, EXIT_USER_ERROR);
                return;
              }

              const operator =
                opts.operator ?? process.env.AI_SDLC_OPERATOR ?? os.userInfo().username;
              const batch = await c.rejectReleaseBatchCandidate.execute({
                batchId: ReleaseBatchId(batchId),
                candidateSha: opts.candidateSha,
                ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
                operator,
              });

              const outputLines = [
                `Release batch ${batch.id} candidate ${opts.candidateSha} rejected:`,
                `  Status: ${batch.status}`,
                ...(batch.blockedReason ? [`  Reason: ${batch.blockedReason}`] : []),
              ];
              await new Promise<void>((resolve, reject) =>
                process.stdout.write(outputLines.join('\n') + '\n', (err) =>
                  err ? reject(err) : resolve(),
                ),
              );

              const isCliTestSuite =
                buildOpts?.isCliTestSuite ?? process.env.AI_CLI_TEST_SUITE === 'true';
              if (!isCliTestSuite) {
                await drainAndExit(c, 0);
              } else {
                await c.drainStartupSweeps?.(DEFAULT_DRAIN_TIMEOUT_MS);
                await c.runNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
                await c.releaseBatchNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
              }
            } catch (err) {
              console.error(err instanceof Error ? err.message : String(err));
              await drainAndExit(containerRef, EXIT_USER_ERROR);
            }
          },
        ),
    )
    .addCommand(
      new Command('remediate')
        .alias('add-issues')
        .description('Append remediation issues to a failed release batch')
        .option('-i, --id <id>', 'Release batch ID (alias for --batch-id)')
        .option('--batch-id <id>', 'Release batch ID')
        .requiredOption(
          '--issues <numbers>',
          'Comma-separated ordered GitHub issue numbers to append (e.g. 104,105)',
        )
        .option('--confirm', 'Confirm appending remediation issues')
        .option(
          '--target-repo-root <path>',
          'Target repository root for runs DB and worktrees (default: orchestrator repo)',
        )
        .action(
          async (opts: {
            id?: string;
            batchId?: string;
            issues: string;
            confirm?: boolean;
            targetRepoRoot?: string;
          }) => {
            let containerRef: Container | undefined;
            try {
              const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
                console.error(`Error: ${msg}`);
                process.exit(EXIT_USER_ERROR);
              });
              const { c } = composeWithTarget(targetRepoRoot, {
                ...(buildOpts !== undefined ? { buildOpts } : {}),
                runStartupSweeps: false,
              });
              containerRef = c;

              const batchId = opts.id ?? opts.batchId;
              if (!batchId) {
                console.error('Error: --batch-id (or -i, --id) is required');
                await drainAndExit(c, EXIT_USER_ERROR);
                return;
              }

              const rawIssues = opts.issues
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
              if (rawIssues.length === 0) {
                console.error(
                  'Error: --issues must specify at least one positive integer issue number',
                );
                await drainAndExit(c, EXIT_USER_ERROR);
                return;
              }

              const issueNumbers: number[] = [];
              for (const raw of rawIssues) {
                if (!/^\d+$/.test(raw)) {
                  console.error(`Error: invalid issue number "${raw}": must be a positive integer`);
                  await drainAndExit(c, EXIT_USER_ERROR);
                  return;
                }
                const n = parseInt(raw, 10);
                if (n < 1) {
                  console.error(`Error: invalid issue number "${raw}": must be >= 1`);
                  await drainAndExit(c, EXIT_USER_ERROR);
                  return;
                }
                issueNumbers.push(n);
              }

              const batch = await c.appendRemediationIssues.execute({
                batchId: ReleaseBatchId(batchId),
                issueNumbers,
              });

              const outputLines = [
                `Remediation issues appended to release batch ${batch.id}:`,
                `  Status:     ${batch.status}`,
                `  Items (${batch.items.length}):  ${batch.items.map((i: { issueNumber: number }) => `#${i.issueNumber}`).join(', ')}`,
              ];
              await new Promise<void>((resolve, reject) =>
                process.stdout.write(outputLines.join('\n') + '\n', (err) =>
                  err ? reject(err) : resolve(),
                ),
              );

              const isCliTestSuite =
                buildOpts?.isCliTestSuite ?? process.env.AI_CLI_TEST_SUITE === 'true';
              if (!isCliTestSuite) {
                await drainAndExit(c, 0);
              } else {
                await c.drainStartupSweeps?.(DEFAULT_DRAIN_TIMEOUT_MS);
                await c.runNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
                await c.releaseBatchNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
              }
            } catch (err) {
              console.error(err instanceof Error ? err.message : String(err));
              await drainAndExit(containerRef, EXIT_USER_ERROR);
            }
          },
        ),
    )
    .addCommand(
      new Command('promote')
        .description('Promote approved release batch to source branch via GitHub PR')
        .option('-i, --id <id>', 'Release batch ID (alias for --batch-id)')
        .option('--batch-id <id>', 'Release batch ID')
        .option('--confirm', 'Confirm release batch promotion')
        .option('--no-auto-merge', 'Do not request auto-merge on promotion PR')
        .option(
          '--target-repo-root <path>',
          'Target repository root for runs DB and worktrees (default: orchestrator repo)',
        )
        .action(
          async (opts: {
            id?: string;
            batchId?: string;
            confirm?: boolean;
            autoMerge?: boolean;
            targetRepoRoot?: string;
          }) => {
            let containerRef: Container | undefined;
            try {
              const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
                console.error(`Error: ${msg}`);
                process.exit(EXIT_USER_ERROR);
              });
              const { c } = composeWithTarget(targetRepoRoot, {
                ...(buildOpts !== undefined ? { buildOpts } : {}),
                runStartupSweeps: false,
              });
              containerRef = c;

              const batchId = opts.id ?? opts.batchId;
              if (!batchId) {
                console.error('Error: --batch-id (or -i, --id) is required');
                await drainAndExit(c, EXIT_USER_ERROR);
                return;
              }

              const autoMerge = opts.autoMerge !== false;
              const result = await c.promoteReleaseBatch.execute({
                batchId: ReleaseBatchId(batchId),
                autoMerge,
              });

              const outputLines = [
                `Release batch ${result.batch.id} promotion initiated:`,
                `  Status:               ${result.batch.status}`,
                `  Promotion PR:         #${result.prNumber}`,
                `  Approved Candidate:   ${result.batch.approvedCandidateSha ?? 'none'}`,
                `  Auto-merge Requested: ${autoMerge ? 'yes' : 'no'}`,
              ];
              await new Promise<void>((resolve, reject) =>
                process.stdout.write(outputLines.join('\n') + '\n', (err) =>
                  err ? reject(err) : resolve(),
                ),
              );

              const isCliTestSuite =
                buildOpts?.isCliTestSuite ?? process.env.AI_CLI_TEST_SUITE === 'true';
              if (!isCliTestSuite) {
                await drainAndExit(c, 0);
              } else {
                await c.drainStartupSweeps?.(DEFAULT_DRAIN_TIMEOUT_MS);
                await c.runNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
                await c.releaseBatchNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
              }
            } catch (err) {
              console.error(err instanceof Error ? err.message : String(err));
              await drainAndExit(containerRef, EXIT_USER_ERROR);
            }
          },
        ),
    )
    .addCommand(
      new Command('integrate-source')
        .description('Integrate source branch drift into release branch for blocked release batch')
        .option('-i, --id <id>', 'Release batch ID (alias for --batch-id)')
        .option('--batch-id <id>', 'Release batch ID')
        .option('--confirm', 'Confirm source branch integration')
        .option(
          '--target-repo-root <path>',
          'Target repository root for runs DB and worktrees (default: orchestrator repo)',
        )
        .action(
          async (opts: {
            id?: string;
            batchId?: string;
            confirm?: boolean;
            targetRepoRoot?: string;
          }) => {
            let containerRef: Container | undefined;
            try {
              const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
                console.error(`Error: ${msg}`);
                process.exit(EXIT_USER_ERROR);
              });
              const { c } = composeWithTarget(targetRepoRoot, {
                ...(buildOpts !== undefined ? { buildOpts } : {}),
                runStartupSweeps: false,
              });
              containerRef = c;

              const batchId = opts.id ?? opts.batchId;
              if (!batchId) {
                console.error('Error: --batch-id (or -i, --id) is required');
                await drainAndExit(c, EXIT_USER_ERROR);
                return;
              }

              const result = await c.releaseBatchCoordinator.integrateSourceBranch(
                ReleaseBatchId(batchId),
              );

              if (!result.success) {
                console.error(`Error: failed to integrate source branch: ${result.error}`);
                await drainAndExit(c, EXIT_USER_ERROR);
                return;
              }

              const outputLines = [
                `Source branch integrated into release batch ${batchId}:`,
                `  New Release Head: ${result.newReleaseSha ?? 'up-to-date'}`,
              ];
              await new Promise<void>((resolve, reject) =>
                process.stdout.write(outputLines.join('\n') + '\n', (err) =>
                  err ? reject(err) : resolve(),
                ),
              );

              const isCliTestSuite =
                buildOpts?.isCliTestSuite ?? process.env.AI_CLI_TEST_SUITE === 'true';
              if (!isCliTestSuite) {
                await drainAndExit(c, 0);
              } else {
                await c.drainStartupSweeps?.(DEFAULT_DRAIN_TIMEOUT_MS);
                await c.runNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
                await c.releaseBatchNotification?.drain?.(DEFAULT_DRAIN_TIMEOUT_MS);
              }
            } catch (err) {
              console.error(err instanceof Error ? err.message : String(err));
              await drainAndExit(containerRef, EXIT_USER_ERROR);
            }
          },
        ),
    );

  registerRepoCommand(program, (targetRepoRoot?: string) => {
    const resolved = resolveTargetRepoRootOrExit(targetRepoRoot, (msg) => {
      console.error(`Error: ${msg}`);
      process.exit(EXIT_USER_ERROR);
    });
    const { c } = composeWithTarget(resolved, {
      ...(buildOpts !== undefined ? { buildOpts } : {}),
    });
    return c;
  });

  return program;
}

const isMain = realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
if (isMain) {
  buildProgram()
    .parseAsync(process.argv)
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      await drainAndExit(undefined, EXIT_INTERNAL_ERROR);
    });
}

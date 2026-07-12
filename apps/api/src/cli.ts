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
  WorkerLeaseConflictError,
  JobId,
  IssueNumber,
  createJob,
  createWorker,
} from '@ai-sdlc/domain';
import { newRunId } from '@ai-sdlc/shared';
import {
  planRunRecoveryAction,
  ReapOrphanedTestWorkers,
  SweepOrphanedRuns,
  checkPid,
} from '@ai-sdlc/application';
import type { RunRepositoryPort } from '@ai-sdlc/application';
import type { SweepOrphanedRunEntry } from '@ai-sdlc/application';
import { composeRoot, type ComposeOptions, seedTestDatabase } from './compose.js';
import { resolveTargetRepoRootOrExit, findRepoRoot } from './cli/target-repo-root.js';
import { composeWithTarget } from './cli/compose-with-target.js';
import { WorkerScheduler } from './worker-scheduler.js';
import { startWorkerDrainLoop } from './worker-drain-loop.js';
import { resolveRepoContext, canonicalizeRepoContext } from './routes/_lib.js';
import { registerRepoCommand } from './cli/repo-commands.js';
import { EXIT_USER_ERROR, EXIT_INTERNAL_ERROR } from './cli/exit-codes.js';

export interface LeaseConfig {
  ttlMs: number;
  heartbeatIntervalMs: number;
}

const DEFAULT_LEASE_TTL_MS = 120_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

const EXIT_SIGINT = 130;
const EXIT_SIGTERM = 143;

export interface BuildProgramOptions {
  composeOverrides?: Partial<ComposeOptions>;
  lease?: Partial<LeaseConfig>;
  isCliTestSuite?: boolean;
  bypassPlanValidation?: boolean;
}

interface LeaseRepo {
  heartbeat(repoId: RepositoryId, workerId: WorkerId, now: Date, expiresAt: Date): void;
  release(repoId: RepositoryId, workerId: WorkerId): void;
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
  ttlMs: number,
  intervalMs: number,
): { stop: () => void } {
  let heartbeatFailures = 0;
  const maxHeartbeatFailures = Math.max(1, Math.ceil(ttlMs / intervalMs) - 1);
  const timer = setInterval(() => {
    const hbNow = new Date();
    try {
      leaseRepo.heartbeat(repoId, workerId, hbNow, new Date(hbNow.getTime() + ttlMs));
      heartbeatFailures = 0;
    } catch (err) {
      heartbeatFailures++;
      if (heartbeatFailures >= maxHeartbeatFailures) {
        console.error(`Fatal: heartbeat failed ${heartbeatFailures}x, aborting run.`);
        clearInterval(timer);
        leaseRepo.release(repoId, workerId);
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
      leaseRepo.release(repoId, workerId);
    },
  };
}

const DEFAULT_WORKER_REGISTRY_HEARTBEAT_INTERVAL_MS = 30_000;

function printRunFailureSummary(uuid: string, reason?: string): void {
  const prefix = reason ? `Run failed: ${reason}` : 'Run failed.';
  console.error(prefix);
  console.error(`Run UUID: ${uuid}`);
  // No --confirm in the hint: `runs resume` intentionally stops and warns
  // when the failed phase is unsafe to retry, and pre-confirming would skip
  // that guard for anyone who copy-pastes the command.
  console.error(`Resume with: orchestrator runs resume --uuid ${uuid}`);
}

function startWorkerRegistryHeartbeat(
  registry: { heartbeat(id: WorkerId, now: Date): void },
  workerId: WorkerId,
  intervalMs: number,
): { stop: () => void } {
  const timer = setInterval(() => {
    try {
      registry.heartbeat(workerId, new Date());
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

const MIN_SWEEP_INTERVAL_MS = 30_000;

type WaitingSweepResult = {
  reactivated: number;
  enqueued: number;
  skippedLeaseConflict: number;
  timedOut: number;
  passedOnMergedPr: number;
  cancelledOnClosedPr: number;
  stayedReady: number;
  skipped: number;
  errors: Array<{ runId: string; error: string }>;
  enqueueErrors: Array<{ runId: string; error: string }>;
};

type OrphanSweepResult = {
  scanned: number;
  enqueued: number;
  skippedLeaseConflict: number;
  skippedAlreadyQueued: number;
  enqueueErrors: Array<{ runId: string; error: string }>;
};

function startPeriodicSweepTimer(
  waitingSweeper: {
    execute(workerId: WorkerId): Promise<WaitingSweepResult>;
  },
  orphanSweeper: {
    execute(entries: SweepOrphanedRunEntry[]): Promise<OrphanSweepResult>;
  },
  isProcessAlive: (pid: number) => boolean,
  runRepository: RunRepositoryPort,
  intervalSeconds: number,
  workerId: WorkerId,
): { stop: () => void } {
  const intervalMs = Math.max(intervalSeconds * 1000, MIN_SWEEP_INTERVAL_MS);
  let isRunning = false;
  const timer = setInterval(() => {
    if (isRunning) return;
    isRunning = true;
    let orphanResult: OrphanSweepResult | undefined;
    let waitingResult: WaitingSweepResult | undefined;
    Promise.resolve()
      .then(() => {
        const sweep = new SweepOrphanedRuns({
          runRepository,
          isProcessAlive,
          now: () => new Date(),
        });
        return sweep.execute();
      })
      .then((discovered) => {
        return orphanSweeper.execute(discovered.orphanedRuns);
      })
      .then((o) => {
        orphanResult = o;
        return waitingSweeper.execute(workerId);
      })
      .then((w) => {
        waitingResult = w;
        isRunning = false;
        const o = orphanResult!;
        if (
          o.enqueued > 0 ||
          o.skippedLeaseConflict > 0 ||
          o.skippedAlreadyQueued > 0 ||
          o.enqueueErrors.length > 0
        ) {
          console.error(
            `Orphan recovery: ${o.enqueued} enqueued, ${o.skippedLeaseConflict} skipped (lease), ${o.skippedAlreadyQueued} skipped (already queued), ${o.enqueueErrors.length} errors`,
          );
          for (const err of o.enqueueErrors) {
            console.error(`  Orphan enqueue error in run ${err.runId}: ${err.error}`);
          }
        }
        if (
          w.reactivated > 0 ||
          w.timedOut > 0 ||
          w.passedOnMergedPr > 0 ||
          w.cancelledOnClosedPr > 0 ||
          w.errors.length > 0 ||
          w.enqueueErrors.length > 0
        ) {
          console.error(
            `Reactivation sweep: ${w.reactivated} reactivated (${w.enqueued} enqueued, ${w.skippedLeaseConflict} skipped due to lease conflict), ${w.timedOut} timed out, ${w.passedOnMergedPr} passed (merged PR), ${w.cancelledOnClosedPr} cancelled (closed PR), ${w.stayedReady} stayed ready, ${w.skipped} skipped, ${w.errors.length} errors, ${w.enqueueErrors.length} enqueue errors`,
          );
          for (const err of w.errors) {
            console.error(`  Error in run ${err.runId}: ${err.error}`);
          }
          for (const err of w.enqueueErrors) {
            console.error(`  Enqueue error in run ${err.runId}: ${err.error}`);
          }
        }
      })
      .catch((err) => {
        isRunning = false;
        if (waitingResult === undefined) {
          console.error('Periodic reactivation sweep error:', err);
        } else {
          console.error('Periodic sweep error (after waiting sweep):', err);
        }
      });
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}

function installSignalHandlers(
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
  onCleanup?: () => void,
): { remove: () => void } {
  const cleanup = async (signal: string) => {
    const existing = runRepository.findByIssueNumber(repoId, issueNumber);
    if (existing && existing.pid === process.pid) {
      runRepository.updateStatusByIssueNumber(repoId, issueNumber, {
        status: 'cancelled',
        completedAt: new Date(),
        failureReason: `interrupted by ${signal}`,
      });
    }
    onCleanup?.();
  };

  const sigintHandler = () => {
    cleanup('SIGINT').finally(() => process.exit(EXIT_SIGINT));
  };
  const sigtermHandler = () => {
    cleanup('SIGTERM').finally(() => process.exit(EXIT_SIGTERM));
  };
  const uncaughtHandler = (err: Error) => {
    cleanup('uncaughtException').finally(() => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(EXIT_USER_ERROR);
    });
  };
  const unhandledHandler = (reason: unknown) => {
    cleanup('unhandledRejection').finally(() => {
      console.error(reason instanceof Error ? reason.message : String(reason));
      process.exit(EXIT_USER_ERROR);
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

export function buildProgram(buildOpts?: BuildProgramOptions): Command {
  const program = new Command();

  program.name('orchestrator').description('AI SDLC Orchestrator CLI').version('0.0.0');

  program
    .command('run')
    .alias('start')
    .description('Start an issue-to-PR run by wrapping the legacy Bash script')
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
    .option(
      '--target-repo-root <path>',
      'Target repository root for worktrees and DB (default: orchestrator repo)',
    )
    .action(async (opts: RunCliOptions & { verbose?: boolean }) => {
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
          },
        });
        if (tee) c.runRepository; // tee consumed below by run command's existing logic
        if (opts.baseBranch !== undefined && c.runRepository) {
          // baseBranch is propagated via the helper, no extra wiring needed
        }

        // --- executor validation ---
        if (opts.executor && !['bash', 'ts'].includes(opts.executor)) {
          console.error(`Error: --executor must be "bash" or "ts", got "${opts.executor}"`);
          process.exit(EXIT_USER_ERROR);
        }

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
          process.exit(EXIT_USER_ERROR);
        }

        const pausedStatuses: RunStatus[] = ['waiting', 'queued'];

        // --- TS executor path ---
        if (opts.executor === 'ts') {
          if (!c.runExecutor) {
            console.error(
              'Error: RunExecutor not available. Ensure agent config is present in .ai-orchestrator.json.',
            );
            process.exit(EXIT_USER_ERROR);
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
            process.exit(EXIT_USER_ERROR);
          }

          if (!c.workerRegistry || !c.workerLoopDeps) {
            console.error(
              'Error: worker registry not available. Ensure agent config is present in .ai-orchestrator.json.',
            );
            process.exit(EXIT_USER_ERROR);
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
              process.exit(EXIT_USER_ERROR);
            }
          }

          const run = createRun({
            uuid: ids.uuid,
            displayId: ids.displayId,
            repoId,
            issueNumber: opts.issue,
            startedAt,
            ...(effectiveBaseBranch ? { baseBranch: effectiveBaseBranch } : {}),
          });

          if (callerRepoId) {
            c.loadRepositoryForRun.execute({
              run,
              callerRepoId: callerRepoId as RepositoryId,
              strictMatch: false,
            });
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
              message: `run.config: executor=ts baseBranch=${effectiveBaseBranch || '(default)'}`,
              timestamp: startedAt.toISOString(),
              metadata: {
                executor: 'ts',
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
                hostname: os.hostname(),
                processId: process.pid,
                now: startedAt,
              }),
            );

            workerHeartbeat = startWorkerRegistryHeartbeat(
              c.workerRegistry,
              workerId,
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

            const handleSignal = (signal: string, exitCode: number) => {
              try {
                abortController.abort();
                testWorkerReaper?.stop();
                const currentJob = c.jobQueue.findById(jobId);
                if (currentJob) {
                  if (currentJob.status === 'claimed') {
                    try {
                      c.jobQueue.releaseClaim(jobId);
                    } catch (err) {
                      console.error(
                        `releaseClaim on signal failed: ${err instanceof Error ? err.message : String(err)}`,
                      );
                    }
                  } else if (currentJob.status === 'running') {
                    try {
                      c.jobQueue.markCancelled(jobId, new Date());
                    } catch (err) {
                      console.error(
                        `markCancelled on signal failed: ${err instanceof Error ? err.message : String(err)}`,
                      );
                    }
                  }
                  // 'queued' is a no-op: the workerLoop's first tick will reclaim naturally.
                }
                workerHeartbeat?.stop();
                c.runRepository.atomicUpdateByUuid(
                  run.uuid,
                  {
                    status: 'cancelled',
                    completedAt: new Date(),
                    failureReason: `interrupted by ${signal}`,
                  },
                  'running',
                );
                try {
                  c.workerLeaseRepository.release(repoId, workerId);
                } catch (err) {
                  console.error(
                    `Failed to release lease on exit: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
                unsubscribe?.();
              } finally {
                process.exit(exitCode);
              }
            };

            sigintHandler = () => handleSignal('SIGINT', EXIT_SIGINT);
            sigtermHandler = () => handleSignal('SIGTERM', EXIT_SIGTERM);
            process.once('SIGINT', sigintHandler);
            process.once('SIGTERM', sigtermHandler);

            const scheduler = new WorkerScheduler([workerId], c.workerLoopDeps);

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
                c.runRepository.atomicUpdateByUuid(
                  run.uuid,
                  {
                    status: 'cancelled',
                    completedAt: new Date(),
                    failureReason: 'aborted during scheduler run',
                  },
                  'running',
                );
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
              c.runRepository.atomicUpdateByUuid(
                run.uuid,
                {
                  status: 'failed',
                  completedAt: new Date(),
                  failureReason: 'worker loop terminated without finalizing run',
                },
                'running',
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
            const isSuccess =
              finalRun.status === 'passed' ||
              pausedStatuses.includes(finalRun.status) ||
              finalJob?.status === 'succeeded';
            if (!isSuccess) {
              printRunFailureSummary(finalRun.uuid, finalRun.failureReason);
            }
            process.exit(isSuccess ? 0 : EXIT_USER_ERROR);
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
            c.runRepository.atomicUpdateByUuid(
              run.uuid,
              {
                status: 'failed',
                completedAt: new Date(),
                failureReason,
              },
              'running',
            );
            // Only suggest resuming if the run row actually exists —
            // insertIfNoActive may have thrown before inserting it.
            if (c.runRepository.findByUuid(run.uuid)) {
              printRunFailureSummary(run.uuid, failureReason);
            } else {
              console.error(`Run failed: ${failureReason}`);
            }
            process.exit(EXIT_USER_ERROR);
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
            process.exit(EXIT_USER_ERROR);
          }

          if (callerRepoId) {
            const dummyRun = { repoId, uuid: '' } as Run;
            c.loadRepositoryForRun.execute({
              run: dummyRun,
              callerRepoId: callerRepoId as RepositoryId,
              strictMatch: false,
            });
          }

          const signalHandlers = installSignalHandlers(c.runRepository, repoId, opts.issue);

          try {
            const out = await c.startIssueRun.execute({
              issueNumber: opts.issue,
              repoId,
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
              printRunFailureSummary(out.uuid, finalRun?.failureReason);
            }
            process.exit(isSuccess ? 0 : EXIT_USER_ERROR);
          } finally {
            signalHandlers.remove();
          }
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(EXIT_INTERNAL_ERROR);
      }
    });

  program
    .command('serve')
    .description('Start the orchestrator HTTP API')
    .option('--port <port>', 'Port to listen on', (v) => parseInt(v, 10), 4319)
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
        const { startServer } = await import('./server.js');
        const server = await startServer({ container: c, port: opts.port });
        const addr = server.address as { port: number };
        console.error(`orchestrator API listening on http://127.0.0.1:${addr.port}`);
        const testWorkerReaper = startTestWorkerReaper(c.reapOrphanedTestWorkers);

        let workerDrainLoop: { stop: () => void } | undefined;
        let serveWorkerHeartbeat: { stop: () => void } | undefined;
        let serveWorkerId: WorkerId | undefined;
        if (c.workerRegistry && c.workerLoopDeps) {
          serveWorkerId = WorkerId(`serve-${process.pid}`);
          c.workerRegistry.register(
            createWorker({
              id: serveWorkerId,
              hostname: os.hostname(),
              processId: process.pid,
              now: new Date(),
            }),
          );
          const heartbeatIntervalMs =
            (typeof buildOpts !== 'undefined' && buildOpts?.lease?.heartbeatIntervalMs) ||
            DEFAULT_WORKER_REGISTRY_HEARTBEAT_INTERVAL_MS;
          serveWorkerHeartbeat = startWorkerRegistryHeartbeat(
            c.workerRegistry,
            serveWorkerId,
            heartbeatIntervalMs,
          );
          workerDrainLoop = startWorkerDrainLoop(serveWorkerId, {
            ...c.workerLoopDeps,
            runRepository: c.runRepository,
          });
        }

        let sweepTimer: { stop: () => void } | undefined;
        let isShuttingDown = false;
        if (c.workerRegistry && c.workerLoopDeps && serveWorkerId) {
          const waitingSweeper = c.buildWaitingRunsSweeper();
          const orphanSweeper = c.buildOrphanedRunsSweeper();

          const initialOrphans = new SweepOrphanedRuns({
            runRepository: c.runRepository,
            isProcessAlive: checkPid,
            now: () => new Date(),
          }).execute();

          Promise.resolve(orphanSweeper.execute(initialOrphans.orphanedRuns))
            .then((orphanRecovery) => {
              if (
                orphanRecovery.enqueued > 0 ||
                orphanRecovery.skippedLeaseConflict > 0 ||
                orphanRecovery.skippedAlreadyQueued > 0 ||
                orphanRecovery.enqueueErrors.length > 0
              ) {
                console.error(
                  `Orphan recovery: ${orphanRecovery.enqueued} enqueued, ${orphanRecovery.skippedLeaseConflict} skipped (lease), ${orphanRecovery.skippedAlreadyQueued} skipped (already queued), ${orphanRecovery.enqueueErrors.length} errors`,
                );
                for (const err of orphanRecovery.enqueueErrors) {
                  console.error(`  Orphan enqueue error in run ${err.runId}: ${err.error}`);
                }
              }
              return waitingSweeper.execute(serveWorkerId);
            })
            .catch((err) => {
              console.error('Initial startup reactivation sweep error:', err);
            })
            .finally(() => {
              if (c.serveSweepIntervalSeconds > 0 && !isShuttingDown) {
                sweepTimer = startPeriodicSweepTimer(
                  waitingSweeper,
                  orphanSweeper,
                  checkPid,
                  c.runRepository,
                  c.serveSweepIntervalSeconds,
                  serveWorkerId,
                );
              }
            });
        }

        const shutdown = async () => {
          if (isShuttingDown) return;
          isShuttingDown = true;
          sweepTimer?.stop();
          workerDrainLoop?.stop();
          serveWorkerHeartbeat?.stop();
          if (serveWorkerId && c.workerRegistry) {
            try {
              c.workerRegistry.deregister(serveWorkerId);
            } catch (err) {
              console.error('Failed to deregister worker on exit:', err);
            }
          }
          testWorkerReaper.stop();
          await server.stop();
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
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
              process.exit(EXIT_USER_ERROR);
            }
            if (opts.issue && opts.uuid) {
              console.error('Error: specify --issue or --uuid, not both');
              process.exit(EXIT_USER_ERROR);
            }
            try {
              const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
                console.error(`Error: ${msg}`);
                process.exit(EXIT_USER_ERROR);
              });
              const { c } = composeWithTarget(targetRepoRoot, {
                ...(buildOpts !== undefined ? { buildOpts } : {}),
              });
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
                  process.exit(EXIT_USER_ERROR);
                }
                const run = c.runRepository.findByIssueNumber(repoId, opts.issue!);
                if (!run) {
                  console.error(`No run found for issue ${opts.issue}`);
                  process.exit(EXIT_USER_ERROR);
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
              await c.cancelRun.execute({
                runId: RunId(uuid),
                ...(opts.reason ? { reason: opts.reason } : {}),
              });
              process.stdout.write('Run cancelled successfully\n');
            } catch (err) {
              console.error(err instanceof Error ? err.message : String(err));
              process.exit(EXIT_USER_ERROR);
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
          try {
            const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
              console.error(`Error: ${msg}`);
              process.exit(EXIT_USER_ERROR);
            });
            const { c } = composeWithTarget(targetRepoRoot, {
              ...(buildOpts !== undefined ? { buildOpts } : {}),
            });
            const callerRepoId = resolveRepoIdForCli({ repositoryId: opts.repositoryId }, c);
            // An unknown UUID must fail, not report ready: listComments on a
            // nonexistent run returns no rows, which would green-light the merge.
            const run = c.runRepository.findByUuid(opts.uuid);
            if (!run) {
              console.error(`No run found for uuid ${opts.uuid}`);
              process.exit(EXIT_USER_ERROR);
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
              process.exit(EXIT_USER_ERROR);
            }
            console.error('Success: PR is ready for merge.');
            process.exit(0);
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(EXIT_USER_ERROR);
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
          try {
            const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
              console.error(`Error: ${msg}`);
              process.exit(EXIT_USER_ERROR);
            });
            const { c } = composeWithTarget(targetRepoRoot, {
              ...(buildOpts !== undefined ? { buildOpts } : {}),
            });
            if (!c.runExecutor) {
              console.error(
                'Error: RunExecutor not available. Ensure agent config is present in .ai-orchestrator.json.',
              );
              process.exit(EXIT_USER_ERROR);
            }
            const run = c.runRepository.findByUuid(opts.uuid);
            if (!run) {
              console.error(`No run found for uuid ${opts.uuid}`);
              process.exit(EXIT_USER_ERROR);
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
              process.exit(EXIT_USER_ERROR);
            }
            const repoId = callerRepoId
              ? (callerRepoId as RepositoryId)
              : c.repoFullName
                ? RepositoryId(c.repoFullName)
                : undefined;
            if (!repoId) {
              console.error('Error: could not determine repository name.');
              process.exit(EXIT_USER_ERROR);
            }
            const workerId = WorkerId(`cli-${process.pid}`);
            const leaseTtlMs = buildOpts?.lease?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
            const heartbeatIntervalMs =
              buildOpts?.lease?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
            try {
              c.workerLeaseRepository.acquire({
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
                process.exit(EXIT_USER_ERROR);
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
            const releaseLeaseOnSignal = () => {
              try {
                testWorkerReaper?.stop();
                c.workerLeaseRepository.release(repoId, workerId);
              } catch (err) {
                console.error(
                  `Failed to release lease on exit: ${(err as Error)?.message ?? String(err)}`,
                );
              }
            };
            try {
              signalHandlers = installSignalHandlers(
                c.runRepository,
                repoId,
                run.issueNumber,
                releaseLeaseOnSignal,
              );
              lease = startLeaseHeartbeat(
                c.workerLeaseRepository,
                repoId,
                workerId,
                leaseTtlMs,
                heartbeatIntervalMs,
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
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(EXIT_USER_ERROR);
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
        .option('--confirm', 'Confirm retry/resume of an unsafe phase')
        .option('--verbose', 'Stream progress to terminal (default: auto when TTY)')
        .option('--no-verbose', 'Suppress streaming progress to terminal')
        .option(
          '--target-repo-root <path>',
          'Target repository root for runs DB and worktrees (default: orchestrator repo)',
        )
        .action(
          async (opts: {
            uuid: string;
            fromPhase?: string;
            confirm?: boolean;
            verbose?: boolean;
            targetRepoRoot?: string;
            repositoryId?: string;
          }) => {
            const isCliTestSuite =
              buildOpts?.isCliTestSuite ?? process.env.AI_CLI_TEST_SUITE === 'true';
            const bypassPlanValidation =
              buildOpts?.bypassPlanValidation ??
              (isCliTestSuite || process.env.AI_BYPASS_PLAN_VALIDATION === 'true');
            try {
              const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
                console.error(`Error: ${msg}`);
                process.exit(EXIT_USER_ERROR);
              });
              const { c } = composeWithTarget(targetRepoRoot, {
                ...(buildOpts !== undefined ? { buildOpts } : {}),
              });
              if (!c.runExecutor) {
                console.error(
                  'Error: RunExecutor not available. Ensure agent config is present in .ai-orchestrator.json.',
                );
                process.exit(EXIT_USER_ERROR);
              }
              const run = c.runRepository.findByUuid(opts.uuid);
              if (!run) {
                console.error(`No run found for uuid ${opts.uuid}`);
                process.exit(EXIT_USER_ERROR);
              }
              const callerRepoId = resolveRepoIdForCli({ repositoryId: opts.repositoryId }, c);
              if (callerRepoId) {
                c.loadRepositoryForRun.execute({
                  run,
                  callerRepoId: callerRepoId as RepositoryId,
                  strictMatch: false,
                });
              }

              const phases = c.phaseRepository.listByRun(opts.uuid);
              const plan = planRunRecoveryAction({
                action: opts.fromPhase ? 'resume' : 'retry',
                run,
                phases,
                ...(opts.fromPhase ? { fromPhase: opts.fromPhase } : {}),
              });

              if (!bypassPlanValidation) {
                if (!plan.allowed) {
                  console.error(plan.denialReason || 'Action not allowed');
                  process.exit(EXIT_USER_ERROR);
                }

                if (plan.requiresConfirmation && !opts.confirm) {
                  console.error(
                    'Retrying this phase can duplicate side effects. Re-run with --confirm to continue.',
                  );
                  process.exit(EXIT_USER_ERROR);
                }
              }

              const repoId = callerRepoId
                ? (callerRepoId as RepositoryId)
                : c.repoFullName
                  ? RepositoryId(c.repoFullName)
                  : undefined;
              if (!repoId) {
                console.error('Error: could not determine repository name.');
                process.exit(EXIT_USER_ERROR);
              }
              const workerId = WorkerId(`cli-${process.pid}`);

              const leaseTtlMs = buildOpts?.lease?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
              const heartbeatIntervalMs =
                buildOpts?.lease?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

              try {
                c.workerLeaseRepository.acquire({
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
                  process.exit(EXIT_USER_ERROR);
                }
                throw new Error(`Failed to acquire worker lease: ${(err as Error).message}`);
              }

              c.runRepository.update(run.uuid, { pid: process.pid });

              let signalHandlers: { remove: () => void } | undefined;
              let lease: { stop: () => void } | undefined;
              let testWorkerReaper: { stop: () => void } | undefined;
              const releaseLeaseOnSignal = () => {
                try {
                  testWorkerReaper?.stop();
                  c.workerLeaseRepository.release(repoId, workerId);
                } catch (err) {
                  console.error(
                    `Failed to release lease on exit: ${(err as Error)?.message ?? String(err)}`,
                  );
                }
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
                );
                lease = startLeaseHeartbeat(
                  c.workerLeaseRepository,
                  repoId,
                  workerId,
                  leaseTtlMs,
                  heartbeatIntervalMs,
                );
                testWorkerReaper = startTestWorkerReaper(c.reapOrphanedTestWorkers);

                if (opts.fromPhase) {
                  await c.resumeRun.transition({
                    runId: RunId(opts.uuid),
                    fromPhase: plan.targetPhase ?? opts.fromPhase,
                    workerId,
                    ...(plan.attempt !== undefined ? { attempt: plan.attempt } : {}),
                  });
                } else {
                  await c.retryFailedPhase.execute({
                    runId: RunId(opts.uuid),
                    workerId,
                  });
                }

                const updatedRun = c.runRepository.findByUuid(opts.uuid);
                if (!updatedRun) {
                  console.error(`Error: run ${opts.uuid} not found after transition.`);
                  process.exit(EXIT_USER_ERROR);
                }

                const result = await c.runExecutor.execute({
                  run: { ...updatedRun, status: 'running' },
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
                unsubscribe?.();
                signalHandlers?.remove();
                lease?.stop();
              }
            } catch (err) {
              console.error(err instanceof Error ? err.message : String(err));
              process.exit(EXIT_USER_ERROR);
            }
            if (!isCliTestSuite) {
              process.exit(0);
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
            try {
              const targetRepoRoot = resolveTargetRepoRootOrExit(opts.targetRepoRoot, (msg) => {
                console.error(`Error: ${msg}`);
                process.exit(EXIT_USER_ERROR);
              });
              const { c } = composeWithTarget(targetRepoRoot, {
                ...(buildOpts !== undefined ? { buildOpts } : {}),
              });
              if (!c.repoFullName) {
                console.error('Error: could not determine repository name.');
                process.exit(EXIT_USER_ERROR);
              }
              const repoId = RepositoryId(c.repoFullName);
              let run = c.runRepository.findByIssueNumber(repoId, opts.issue);
              if (!run) {
                console.error(`No run found for issue ${opts.issue}`);
                process.exit(EXIT_USER_ERROR);
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
                process.exit(0);
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
            } catch (err) {
              console.error(err instanceof Error ? err.message : String(err));
              process.exit(EXIT_USER_ERROR);
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
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(EXIT_INTERNAL_ERROR);
    });
}

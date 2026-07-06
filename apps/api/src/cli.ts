import { existsSync, realpathSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import {
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
import { planRunRecoveryAction } from '@ai-sdlc/application';
import { composeRoot, type ComposeOptions } from './compose.js';
import { WorkerScheduler } from './worker-scheduler.js';

export interface LeaseConfig {
  ttlMs: number;
  heartbeatIntervalMs: number;
}

const DEFAULT_LEASE_TTL_MS = 120_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

const EXIT_USER_ERROR = 1;
const EXIT_INTERNAL_ERROR = 2;
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

export function findRepoRoot(
  startDir: string,
  exists: (p: string) => boolean = existsSync,
): string {
  let dir = startDir;
  for (;;) {
    if (exists(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return startDir;
    }
    dir = parent;
  }
}

export interface RunCliOptions {
  issue: number;
  script: string;
  baseBranch?: string;
  model?: string;
  agentCli?: string;
  executor?: string;
  targetRepoRoot?: string;
}

export function buildProgram(buildOpts?: BuildProgramOptions): Command {
  const program = new Command();

  program.name('orchestrator').description('AI SDLC Orchestrator CLI').version('0.0.0');

  program
    .command('run')
    .description('Start an issue-to-PR run by wrapping the legacy Bash script')
    .requiredOption('--issue <number>', 'GitHub issue number', (v) => {
      if (!/^\d+$/.test(v)) throw new Error(`--issue must be a positive integer, got: ${v}`);
      const n = parseInt(v, 10);
      if (n < 1) throw new Error(`--issue must be >= 1, got: ${v}`);
      return n;
    })
    .option('--base-branch <branch>', 'Base branch (legacy default: main)')
    .option('--model <model>', 'AI_AGENT_MODEL env var')
    .option('--agent-cli <cli>', 'AI_RUNTIME env var')
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
        // Validate --target-repo-root early so composeRoot never sees a
        // bad path. Relative paths are resolved against process.cwd().
        let targetRepoRoot: string | undefined;
        if (opts.targetRepoRoot !== undefined) {
          targetRepoRoot = resolve(process.cwd(), opts.targetRepoRoot);
          if (!existsSync(targetRepoRoot) || !statSync(targetRepoRoot).isDirectory()) {
            console.error(
              `Error: --target-repo-root is not an existing directory: ${targetRepoRoot}`,
            );
            process.exit(EXIT_USER_ERROR);
          }
          try {
            execFileSync('git', ['-C', targetRepoRoot, 'rev-parse', '--git-dir'], {
              stdio: 'pipe',
            });
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
              console.error(`Error: git CLI not found; cannot validate --target-repo-root.`);
            } else {
              console.error(
                `Error: --target-repo-root is not inside a git working tree: ${targetRepoRoot}`,
              );
            }
            process.exit(EXIT_USER_ERROR);
          }
        }

        const repoRoot = findRepoRoot(process.cwd());
        const scriptPath = opts.script
          ? isAbsolute(opts.script)
            ? opts.script
            : resolve(repoRoot, opts.script)
          : join(repoRoot, 'scripts', 'legacy', 'ai-run-issue-v2');
        const tee = opts.verbose ?? Boolean(process.stdout.isTTY);
        const options: ComposeOptions = {
          repoRoot,
          scriptPath,
          tee,
          ...buildOpts?.composeOverrides,
        };
        if (opts.baseBranch !== undefined) options.baseBranch = opts.baseBranch;
        if (opts.model !== undefined) options.model = opts.model;
        if (opts.agentCli !== undefined) options.agentCli = opts.agentCli;
        if (opts.targetRepoRoot !== undefined) options.targetRepoRoot = opts.targetRepoRoot;
        const c = composeRoot(options);

        // --- executor validation ---
        if (opts.executor && !['bash', 'ts'].includes(opts.executor)) {
          console.error(`Error: --executor must be "bash" or "ts", got "${opts.executor}"`);
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
          if (!c.repoFullName) {
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
          const repoId = RepositoryId(c.repoFullName);
          const run = createRun({
            uuid: ids.uuid,
            displayId: ids.displayId,
            repoId,
            issueNumber: opts.issue,
            startedAt,
          });

          const jobId = JobId(randomUUID());
          const workerId = WorkerId(`cli-${process.pid}`);
          const abortController = new AbortController();

          let unsubscribe: (() => void) | undefined;
          let sigintHandler: (() => void) | undefined;
          let sigtermHandler: (() => void) | undefined;
          let workerHeartbeat: { stop: () => void } | undefined;

          try {
            c.runRepository.insertIfNoActive(run);

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

            if (tee) {
              unsubscribe = c.eventBus.subscribe(ids.uuid, (event) => {
                console.error(`[ts] ${event.message}`);
              });
            }

            const handleSignal = (signal: string, exitCode: number) => {
              try {
                abortController.abort();
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
                const currentRun = c.runRepository.findByUuid(run.uuid);
                if (currentRun && currentRun.status === 'running') {
                  c.runRepository.update(run.uuid, {
                    status: 'cancelled',
                    completedAt: new Date(),
                    failureReason: `interrupted by ${signal}`,
                  });
                }
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
          if (!c.repoFullName) {
            console.error(
              'Error: could not determine repository name. Ensure gh CLI is authenticated and run from a GitHub repository.',
            );
            process.exit(EXIT_USER_ERROR);
          }

          const repoId = RepositoryId(c.repoFullName);
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
    .action(
      async (opts: {
        port: number;
        script?: string;
        repoRoot?: string;
        dbPath?: string;
        runsDir?: string;
      }) => {
        const repoRoot = opts.repoRoot ?? findRepoRoot(process.cwd());
        const scriptPath = opts.script
          ? isAbsolute(opts.script)
            ? opts.script
            : resolve(repoRoot, opts.script)
          : join(repoRoot, 'scripts', 'legacy', 'ai-run-issue-v2');
        const composeOpts: ComposeOptions = {
          repoRoot,
          scriptPath,
          ...buildOpts?.composeOverrides,
        };
        if (opts.dbPath) composeOpts.dbPath = opts.dbPath;
        if (opts.runsDir) composeOpts.runsDir = opts.runsDir;
        const c = composeRoot(composeOpts);
        const { startServer } = await import('./server.js');
        const server = await startServer({ container: c, port: opts.port });
        const addr = server.address as { port: number };
        console.error(`orchestrator API listening on http://127.0.0.1:${addr.port}`);
        const shutdown = async () => {
          await server.stop();
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      },
    );

  program
    .command('repos')
    .description('Manage registered repositories')
    .addCommand(
      new Command('register')
        .description('Register a new repository')
        .argument('<path>', 'Local path to the repository')
        .option('--id <id>', 'Optional stable ID (defaults to nameWithOwner)')
        .option('--disabled', 'Register in disabled state')
        .action(async (path: string, opts: { id?: string; disabled?: boolean }) => {
          try {
            const repoRoot = findRepoRoot(process.cwd());
            const c = composeRoot({
              repoRoot,
              scriptPath: join(repoRoot, 'scripts', 'legacy', 'ai-run-issue-v2'),
            });
            const localPath = resolve(process.cwd(), path);
            const repo = await c.registerRepository.execute({
              localBasePath: localPath,
              id: opts.id,
              enabled: !opts.disabled,
            });
            process.stdout.write(`Registered repository: ${repo.fullName} (ID: ${repo.id})\n`);
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(EXIT_USER_ERROR);
          }
        }),
    )
    .addCommand(
      new Command('list')
        .description('List all registered repositories')
        .action(async () => {
          try {
            const repoRoot = findRepoRoot(process.cwd());
            const c = composeRoot({
              repoRoot,
              scriptPath: join(repoRoot, 'scripts', 'legacy', 'ai-run-issue-v2'),
            });
            const repos = await c.listRepositories.execute();
            if (repos.length === 0) {
              process.stdout.write('No repositories registered.\n');
              return;
            }
            const headers = ['ID', 'Full Name', 'Enabled', 'Path', 'Health'];
            const rows = repos.map((r) => [
              r.id,
              r.fullName,
              r.enabled ? 'yes' : 'no',
              r.localBasePath,
              r.healthStatus,
            ]);
            // Simple table formatting
            const colWidths = headers.map((h, i) =>
              Math.max(h.length, ...rows.map((r) => String(r[i]).length)),
            );
            const formatRow = (row: string[]) =>
              row.map((val, i) => String(val).padEnd(colWidths[i]!)).join('  ') + '\n';

            process.stdout.write(formatRow(headers));
            process.stdout.write(colWidths.map((w) => '-'.repeat(w)).join('  ') + '\n');
            rows.forEach((row) => process.stdout.write(formatRow(row)));
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(EXIT_USER_ERROR);
          }
        }),
    )
    .addCommand(
      new Command('inspect')
        .description('Show detailed information for a repository')
        .argument('<id>', 'Repository ID')
        .action(async (id: string) => {
          try {
            const repoRoot = findRepoRoot(process.cwd());
            const c = composeRoot({
              repoRoot,
              scriptPath: join(repoRoot, 'scripts', 'legacy', 'ai-run-issue-v2'),
            });
            const repo = await c.getRepository.execute(RepositoryId(id));
            if (!repo) {
              console.error(`Repository not found: ${id}`);
              process.exit(EXIT_USER_ERROR);
            }
            process.stdout.write(JSON.stringify(repo, null, 2) + '\n');
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(EXIT_USER_ERROR);
          }
        }),
    )
    .addCommand(
      new Command('enable')
        .description('Enable a repository')
        .argument('<id>', 'Repository ID')
        .action(async (id: string) => {
          try {
            const repoRoot = findRepoRoot(process.cwd());
            const c = composeRoot({
              repoRoot,
              scriptPath: join(repoRoot, 'scripts', 'legacy', 'ai-run-issue-v2'),
            });
            await c.updateRepository.execute({ id: RepositoryId(id), enabled: true });
            process.stdout.write(`Repository ${id} enabled.\n`);
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(EXIT_USER_ERROR);
          }
        }),
    )
    .addCommand(
      new Command('disable')
        .description('Disable a repository')
        .argument('<id>', 'Repository ID')
        .action(async (id: string) => {
          try {
            const repoRoot = findRepoRoot(process.cwd());
            const c = composeRoot({
              repoRoot,
              scriptPath: join(repoRoot, 'scripts', 'legacy', 'ai-run-issue-v2'),
            });
            await c.updateRepository.execute({ id: RepositoryId(id), enabled: false });
            process.stdout.write(`Repository ${id} disabled.\n`);
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(EXIT_USER_ERROR);
          }
        }),
    )
    .addCommand(
      new Command('refresh')
        .description('Refresh repository metadata and health status')
        .argument('<id>', 'Repository ID')
        .action(async (id: string) => {
          try {
            const repoRoot = findRepoRoot(process.cwd());
            const c = composeRoot({
              repoRoot,
              scriptPath: join(repoRoot, 'scripts', 'legacy', 'ai-run-issue-v2'),
            });
            const repo = await c.refreshRepository.execute({ id: RepositoryId(id) });
            process.stdout.write(`Refreshed repository ${id}. Health: ${repo.healthStatus}\n`);
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(EXIT_USER_ERROR);
          }
        }),
    )
    .addCommand(
      new Command('remove')
        .description('Remove a repository from the registry')
        .argument('<id>', 'Repository ID')
        .action(async (id: string) => {
          try {
            const repoRoot = findRepoRoot(process.cwd());
            const c = composeRoot({
              repoRoot,
              scriptPath: join(repoRoot, 'scripts', 'legacy', 'ai-run-issue-v2'),
            });
            await c.removeRepository.execute(RepositoryId(id));
            process.stdout.write(`Removed repository ${id}.\n`);
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(EXIT_USER_ERROR);
          }
        }),
    );

  program
    .command('runs')
    .description('Manage orchestrator runs')
    .addCommand(
      new Command('cancel')
        .description('Cancel an active run')
        .option('--issue <number>', 'Issue number', (v) => {
          if (!/^\d+$/.test(v)) throw new Error(`--issue must be a positive integer, got: ${v}`);
          const n = parseInt(v, 10);
          if (n < 1) throw new Error(`--issue must be >= 1, got: ${v}`);
          return n;
        })
        .option('--uuid <uuid>', 'Run UUID')
        .option('--reason <string>', 'Cancellation reason')
        .action(async (opts: { issue?: number; uuid?: string; reason?: string }) => {
          if (!opts.issue && !opts.uuid) {
            console.error('Error: specify --issue or --uuid');
            process.exit(EXIT_USER_ERROR);
          }
          if (opts.issue && opts.uuid) {
            console.error('Error: specify --issue or --uuid, not both');
            process.exit(EXIT_USER_ERROR);
          }
          try {
            const repoRoot = findRepoRoot(process.cwd());
            const options: ComposeOptions = {
              repoRoot,
              scriptPath: join(repoRoot, 'scripts', 'legacy', 'ai-run-issue-v2'),
              ...buildOpts?.composeOverrides,
            };
            const c = composeRoot(options);
            let uuid: string;
            if (opts.uuid) {
              uuid = opts.uuid;
            } else {
              if (!c.repoFullName) {
                console.error('Error: could not determine repository name.');
                process.exit(EXIT_USER_ERROR);
              }
              const repoId = RepositoryId(c.repoFullName);
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
        }),
    )
    .addCommand(
      new Command('check-merge-ready')
        .description('Verify that a run has no unverified or blocked review comments')
        .requiredOption('--uuid <uuid>', 'Run UUID')
        .action(async (opts: { uuid: string }) => {
          try {
            const repoRoot = findRepoRoot(process.cwd());
            const options: ComposeOptions = {
              repoRoot,
              scriptPath: join(repoRoot, 'scripts', 'legacy', 'ai-run-issue-v2'),
              runStartupSweeps: false,
              ...buildOpts?.composeOverrides,
            };
            const c = composeRoot(options);
            // An unknown UUID must fail, not report ready: listComments on a
            // nonexistent run returns no rows, which would green-light the merge.
            const run = c.runRepository.findByUuid(opts.uuid);
            if (!run) {
              console.error(`No run found for uuid ${opts.uuid}`);
              process.exit(EXIT_USER_ERROR);
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
        .action(async (opts: { uuid: string }) => {
          try {
            const repoRoot = findRepoRoot(process.cwd());
            const options: ComposeOptions = {
              repoRoot,
              scriptPath: join(repoRoot, 'scripts', 'legacy', 'ai-run-issue-v2'),
              runStartupSweeps: false,
              ...buildOpts?.composeOverrides,
            };
            const c = composeRoot(options);
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
            if (run.status !== 'queued' && run.status !== 'running' && run.status !== 'waiting') {
              console.error(
                `Run ${opts.uuid} has status ${run.status}, expected queued, running, or waiting`,
              );
              process.exit(EXIT_USER_ERROR);
            }
            if (!c.repoFullName) {
              console.error('Error: could not determine repository name.');
              process.exit(EXIT_USER_ERROR);
            }
            const repoId = RepositoryId(c.repoFullName);
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
            const releaseLeaseOnSignal = () => {
              try {
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
        .description('Resume a failed or blocked run')
        .requiredOption('--uuid <uuid>', 'Run UUID')
        .option(
          '--from-phase <phase>',
          'Phase to resume from (default: auto-detect failed or blocked phase)',
        )
        .option('--confirm', 'Confirm retry/resume of an unsafe phase')
        .option('--verbose', 'Stream progress to terminal (default: auto when TTY)')
        .option('--no-verbose', 'Suppress streaming progress to terminal')
        .action(
          async (opts: {
            uuid: string;
            fromPhase?: string;
            confirm?: boolean;
            verbose?: boolean;
          }) => {
            const isCliTestSuite =
              buildOpts?.isCliTestSuite ?? process.env.AI_CLI_TEST_SUITE === 'true';
            const bypassPlanValidation =
              buildOpts?.bypassPlanValidation ??
              (isCliTestSuite || process.env.AI_BYPASS_PLAN_VALIDATION === 'true');
            try {
              const repoRoot = findRepoRoot(process.cwd());
              const options: ComposeOptions = {
                repoRoot,
                scriptPath: join(repoRoot, 'scripts', 'legacy', 'ai-run-issue-v2'),
                runStartupSweeps: false,
                ...buildOpts?.composeOverrides,
              };
              const c = composeRoot(options);
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
              if (!c.repoFullName) {
                console.error('Error: could not determine repository name.');
                process.exit(EXIT_USER_ERROR);
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

              const repoId = RepositoryId(c.repoFullName);
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
              const releaseLeaseOnSignal = () => {
                try {
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
                  console.error(`[ts] ${event.message}`);
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
        .action(async (opts: { issue: number; follow: boolean; lines: number }) => {
          try {
            const repoRoot = findRepoRoot(process.cwd());
            const options: ComposeOptions = {
              repoRoot,
              scriptPath: join(repoRoot, 'scripts', 'legacy', 'ai-run-issue-v2'),
              ...buildOpts?.composeOverrides,
            };
            const c = composeRoot(options);
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
        }),
    );

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

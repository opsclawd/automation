import { existsSync, realpathSync } from 'node:fs';
import { Command } from 'commander';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RunId,
  RunStatus,
  createRun,
  WorkerId,
  RepositoryId,
  WorkerLeaseConflictError,
} from '@ai-sdlc/domain';
import { newRunId } from '@ai-sdlc/shared';
import { composeRoot, type ComposeOptions } from './compose.js';

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

function installSignalHandlers(
  runRepository: {
    findByIssueNumber(n: number): { pid?: number | null } | undefined;
    updateStatusByIssueNumber(
      issueNumber: number,
      patch: { status: RunStatus; completedAt: Date; failureReason?: string },
    ): boolean;
  },
  issueNumber: number,
): { remove: () => void } {
  const cleanup = async (signal: string) => {
    const existing = runRepository.findByIssueNumber(issueNumber);
    if (existing && existing.pid === process.pid) {
      runRepository.updateStatusByIssueNumber(issueNumber, {
        status: 'cancelled',
        completedAt: new Date(),
        failureReason: `interrupted by ${signal}`,
      });
    }
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
      'Execution engine: bash (default) or ts (TypeScript RunExecutor)',
      'bash',
    )
    .action(async (opts: RunCliOptions & { verbose?: boolean }) => {
      try {
        const repoRoot = findRepoRoot(process.cwd());
        const scriptPath = opts.script
          ? isAbsolute(opts.script)
            ? opts.script
            : resolve(repoRoot, opts.script)
          : join(repoRoot, 'scripts', 'ai-run-issue-v2');
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
        const c = composeRoot(options);

        // --- executor validation ---
        if (opts.executor && !['bash', 'ts'].includes(opts.executor)) {
          console.error(`Error: --executor must be "bash" or "ts", got "${opts.executor}"`);
          process.exit(EXIT_USER_ERROR);
        }

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

          const workerId = WorkerId(`cli-${process.pid}`);
          const repoId = RepositoryId(c.repoFullName);
          const startedAt = new Date();
          const ids = newRunId({ issueNumber: opts.issue, now: startedAt });
          const run = createRun({
            uuid: ids.uuid,
            displayId: ids.displayId,
            issueNumber: opts.issue,
            startedAt,
          });

          const leaseTtlMs = buildOpts?.lease?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
          const heartbeatIntervalMs =
            buildOpts?.lease?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

          try {
            c.workerLeaseRepository.acquire({
              repoId,
              workerId,
              runId: RunId(run.uuid),
              now: startedAt,
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

          let signalHandlers: { remove: () => void } | undefined;
          let lease: { stop: () => void } | undefined;
          const worktreePath = join(repoRoot, '.ai-worktrees', `issue-${opts.issue}`);
          try {
            signalHandlers = installSignalHandlers(c.runRepository, opts.issue);
            lease = startLeaseHeartbeat(
              c.workerLeaseRepository,
              repoId,
              workerId,
              leaseTtlMs,
              heartbeatIntervalMs,
            );

            c.runRepository.insertIfNoActive(run);
            await c.git.createWorktree({
              repoLocalBasePath: repoRoot,
              worktreePath,
              branch: `ai/issue-${opts.issue}`,
              baseBranch: c.defaultBranch,
            });
            const sha = await c.git.headCommitSha(worktreePath);
            c.runRepository.update(run.uuid, { startCommitSha: sha });
            const result = await c.runExecutor.execute({
              run,
              skip: [],
              presentArtifacts: [],
            });
            if (result.run.status === 'passed') {
              try {
                await c.git.removeWorktree(worktreePath);
              } catch {
                // best-effort: leave worktree intact on cleanup failure
              }
            }
            await new Promise<void>((resolve, reject) =>
              process.stdout.write(
                JSON.stringify({ run: result.run, phases: result.phases }) + '\n',
                (err) => (err ? reject(err) : resolve()),
              ),
            );
            // Release the lease BEFORE process.exit — process.exit() does not run
            // the finally block, so relying on it leaks the lease on every
            // completed run. With no worker-loop to reclaim expired leases on the
            // Option-A direct path, a leaked lease locks the repo after one run.
            signalHandlers?.remove();
            lease?.stop();
            process.exit(result.run.status === 'passed' ? 0 : EXIT_USER_ERROR);
          } catch (err) {
            signalHandlers?.remove();
            lease?.stop();
            try {
              // Only mark failed if the run is still 'running'. runExecutor.execute()
              // persists its own terminal status (passed / blocked / cancelled /
              // needs_human_review / failed) before returning, so a throw AFTER it
              // returns — e.g. process.stdout.write rejecting (EPIPE) or lease.stop
              // throwing — must NOT overwrite that status with 'failed'. The
              // conditional update is a no-op unless the run is still 'running'
              // (i.e. execute() itself threw before finalizing a status).
              c.runRepository.atomicUpdateByUuid(
                run.uuid,
                {
                  status: 'failed',
                  completedAt: new Date(),
                  // Clear currentPhase on failure, matching the domain failRun()
                  // transition (run.ts) and CancelRun's terminal update.
                  currentPhase: null,
                  failureReason: err instanceof Error ? err.message : String(err),
                },
                'running',
              );
            } catch {
              // best-effort: DB write may fail
            }
            try {
              await c.git.removeWorktree(worktreePath);
            } catch {
              // best-effort: may not exist or already removed
            }
            console.error(
              `Run ${run.uuid} (issue #${run.issueNumber}) failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            process.exit(EXIT_INTERNAL_ERROR);
          }
          // No finally: process.exit() bypasses it. Both the success and catch
          // paths above release the lease (signalHandlers.remove + lease.stop)
          // immediately before exiting, so the lease is released exactly once.
        } else {
          // --- Bash executor path ---

          const signalHandlers = installSignalHandlers(c.runRepository, opts.issue);

          try {
            const out = await c.startIssueRun.execute({
              issueNumber: opts.issue,
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
            process.exit(out.status === 'passed' ? 0 : EXIT_USER_ERROR);
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
          : join(repoRoot, 'scripts', 'ai-run-issue-v2');
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
              scriptPath: join(repoRoot, 'scripts', 'ai-run-issue-v2'),
              ...buildOpts?.composeOverrides,
            };
            const c = composeRoot(options);
            let uuid: string;
            if (opts.uuid) {
              uuid = opts.uuid;
            } else {
              const run = c.runRepository.findByIssueNumber(opts.issue!);
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
      new Command('execute')
        .description('Execute a queued run through the RunExecutor')
        .requiredOption('--uuid <uuid>', 'Run UUID to execute')
        .action(async (opts: { uuid: string }) => {
          try {
            const repoRoot = findRepoRoot(process.cwd());
            const options: ComposeOptions = {
              repoRoot,
              scriptPath: join(repoRoot, 'scripts', 'ai-run-issue-v2'),
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
            if (run.status !== 'queued' && run.status !== 'running') {
              console.error(
                `Run ${opts.uuid} has status ${run.status}, expected queued or running`,
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

            c.runRepository.update(run.uuid, { pid: process.pid });

            let signalHandlers: { remove: () => void } | undefined;
            let lease: { stop: () => void } | undefined;
            try {
              signalHandlers = installSignalHandlers(c.runRepository, run.issueNumber);
              lease = startLeaseHeartbeat(
                c.workerLeaseRepository,
                repoId,
                workerId,
                leaseTtlMs,
                heartbeatIntervalMs,
              );
              const result = await c.runExecutor.execute({
                run,
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

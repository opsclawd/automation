import { existsSync, realpathSync } from 'node:fs';
import { Command } from 'commander';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunId } from '@ai-sdlc/domain';
import { composeRoot, type ComposeOptions } from './compose.js';

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
}

export function buildProgram(): Command {
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
        };
        if (opts.baseBranch !== undefined) options.baseBranch = opts.baseBranch;
        if (opts.model !== undefined) options.model = opts.model;
        if (opts.agentCli !== undefined) options.agentCli = opts.agentCli;
        const c = composeRoot(options);

        const cleanup = async (signal: string) => {
          const existing = c.runRepository.findByIssueNumber(opts.issue);
          if (existing && existing.pid === process.pid) {
            c.runRepository.updateStatusByIssueNumber(opts.issue, {
              status: 'cancelled',
              completedAt: new Date(),
              failureReason: `interrupted by ${signal}`,
            });
          }
        };

        const sigintHandler = () => {
          cleanup('SIGINT').finally(() => process.exit(130));
        };
        const sigtermHandler = () => {
          cleanup('SIGTERM').finally(() => process.exit(143));
        };
        const uncaughtHandler = (err: Error) => {
          cleanup('uncaughtException').finally(() => {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
          });
        };
        const unhandledHandler = (reason: unknown) => {
          cleanup('unhandledRejection').finally(() => {
            console.error(reason instanceof Error ? reason.message : String(reason));
            process.exit(1);
          });
        };

        process.on('SIGINT', sigintHandler);
        process.on('SIGTERM', sigtermHandler);
        process.on('uncaughtException', uncaughtHandler);
        process.on('unhandledRejection', unhandledHandler);

        try {
          const out = await c.startIssueRun.execute({ issueNumber: opts.issue });
          // Use process.stdout.write with a callback (not console.log) because
          // process.exit() does not wait for stdout to flush.
          await new Promise<void>((resolve, reject) =>
            process.stdout.write(JSON.stringify(out) + '\n', (err) =>
              err ? reject(err) : resolve(),
            ),
          );
          process.exit(out.status === 'passed' ? 0 : 1);
        } finally {
          process.off('SIGINT', sigintHandler);
          process.off('SIGTERM', sigtermHandler);
          process.off('uncaughtException', uncaughtHandler);
          process.off('unhandledRejection', unhandledHandler);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
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
        const composeOpts: ComposeOptions = { repoRoot, scriptPath };
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
            process.exit(1);
          }
          if (opts.issue && opts.uuid) {
            console.error('Error: specify --issue or --uuid, not both');
            process.exit(1);
          }
          try {
            const repoRoot = findRepoRoot(process.cwd());
            const options: ComposeOptions = {
              repoRoot,
              scriptPath: join(repoRoot, 'scripts', 'ai-run-issue-v2'),
            };
            const c = composeRoot(options);
            let uuid: string;
            if (opts.uuid) {
              uuid = opts.uuid;
            } else {
              const run = c.runRepository.findByIssueNumber(opts.issue!);
              if (!run) {
                console.error(`No run found for issue ${opts.issue}`);
                process.exit(1);
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
            process.exit(1);
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
      process.exit(2);
    });
}

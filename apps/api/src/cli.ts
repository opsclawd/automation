import { existsSync, realpathSync } from 'node:fs';
import { Command } from 'commander';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeRoot, type ComposeOptions } from './compose.js';

export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
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
    .option('--model <model>', 'AI_MODEL env var')
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
        const out = await c.startIssueRun.execute({ issueNumber: opts.issue });
        // Flush stdout before exit; on some redirected stdout configurations
        // process.exit can truncate buffered writes.
        await new Promise<void>((resolve, reject) =>
          process.stdout.write(JSON.stringify(out) + '\n', (err) =>
            err ? reject(err) : resolve(),
          ),
        );
        process.exit(out.status === 'passed' ? 0 : 1);
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
    .action(async (opts: { port: number; script?: string; repoRoot?: string; dbPath?: string }) => {
      const repoRoot = opts.repoRoot ?? findRepoRoot(process.cwd());
      const scriptPath = opts.script
        ? isAbsolute(opts.script)
          ? opts.script
          : resolve(repoRoot, opts.script)
        : join(repoRoot, 'scripts', 'ai-run-issue-v2');
      const composeOpts: ComposeOptions = { repoRoot, scriptPath };
      if (opts.dbPath) composeOpts.dbPath = opts.dbPath;
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
    });

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

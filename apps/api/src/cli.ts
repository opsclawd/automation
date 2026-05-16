import { Command } from 'commander';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeRoot, type ComposeOptions } from './compose.js';

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
      const n = parseInt(v, 10);
      if (Number.isNaN(n)) throw new Error(`--issue must be a number, got: ${v}`);
      return n;
    })
    .option('--base-branch <branch>', 'Base branch (legacy default: main)')
    .option('--model <model>', 'AI_MODEL env var')
    .option('--agent-cli <cli>', 'AI_RUNTIME env var')
    .option(
      '--script <path>',
      'Path to Bash script to wrap',
      resolve(process.cwd(), 'scripts/ai-run-issue-v2'),
    )
    .action(async (opts: RunCliOptions) => {
      try {
        const options: ComposeOptions = {
          repoRoot: process.cwd(),
          scriptPath: opts.script,
        };
        if (opts.baseBranch !== undefined) options.baseBranch = opts.baseBranch;
        if (opts.model !== undefined) options.model = opts.model;
        if (opts.agentCli !== undefined) options.agentCli = opts.agentCli;
        const c = composeRoot(options);
        const out = await c.startIssueRun.execute({ issueNumber: opts.issue });
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(out));
        process.exit(out.status === 'passed' ? 0 : 1);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
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

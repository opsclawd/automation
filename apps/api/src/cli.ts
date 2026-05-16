#!/usr/bin/env -S node --import tsx/esm
import { Command } from 'commander';
import { resolve } from 'node:path';
import { composeRoot, type ComposeOptions } from './compose.js';

const program = new Command();

program.name('orchestrator').description('AI SDLC Orchestrator CLI').version('0.0.0');

program
  .command('run')
  .description('Start an issue-to-PR run by wrapping the legacy Bash script')
  .requiredOption('--issue <number>', 'GitHub issue number', (v) => parseInt(v, 10))
  .option('--base-branch <branch>', 'Base branch (legacy default: main)')
  .option('--model <model>', 'AI_MODEL env var')
  .option('--agent-cli <cli>', 'AI_RUNTIME env var')
  .option(
    '--script <path>',
    'Path to Bash script to wrap',
    resolve(process.cwd(), 'scripts/ai-run-issue-v2'),
  )
  .action(async (opts) => {
    try {
      const options: ComposeOptions = {
        repoRoot: process.cwd(),
        scriptPath: opts.script as string,
      };
      if (opts.baseBranch !== undefined) options.baseBranch = opts.baseBranch as string;
      if (opts.model !== undefined) options.model = opts.model as string;
      if (opts.agentCli !== undefined) options.agentCli = opts.agentCli as string;
      const c = composeRoot(options);
      const out = await c.startIssueRun.execute({ issueNumber: opts.issue as number });
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(out));
      process.exit(out.status === 'passed' ? 0 : 1);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});

#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { composeRoot } from '@ai-sdlc/api/compose.js';
import type { PollerTerminalState } from '@ai-sdlc/application';
import { RepositoryId, RunId, PhaseName } from '@ai-sdlc/domain';

export interface PollArgs {
  prNumber: number;
  issueNumber?: number;
  repoFullName: string;
  cwd: string;
  maxPolls: number;
  pollIntervalSeconds: number;
  runId?: string;
}

function requirePositiveInt(raw: string | undefined, flag: string): number {
  if (raw === undefined || raw === '') {
    throw new Error(`missing required flag: ${flag}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`invalid value for ${flag}: must be a positive integer (got "${raw}")`);
  }
  return n;
}

export function parsePollArgs(argv: string[]): PollArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      pr: { type: 'string' },
      issue: { type: 'string' },
      repo: { type: 'string' },
      cwd: { type: 'string' },
      'max-polls': { type: 'string' },
      'interval-seconds': { type: 'string' },
      'run-id': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.pr) throw new Error('missing required flag: --pr');
  if (!values.repo) throw new Error('missing required flag: --repo');
  if (!values.cwd) throw new Error('missing required flag: --cwd');
  return {
    prNumber: requirePositiveInt(values.pr, '--pr'),
    ...(values.issue ? { issueNumber: requirePositiveInt(values.issue, '--issue') } : {}),
    repoFullName: values.repo,
    cwd: values.cwd,
    maxPolls: values['max-polls'] ? requirePositiveInt(values['max-polls'], '--max-polls') : 3,
    pollIntervalSeconds: values['interval-seconds']
      ? requirePositiveInt(values['interval-seconds'], '--interval-seconds')
      : 300,
    ...(values['run-id'] ? { runId: values['run-id'] } : {}),
  };
}

export function exitCodeForTerminalState(state: PollerTerminalState): number {
  switch (state) {
    case 'all_resolved':
    case 'max_polls_reached':
      return 0;
    case 'blocked':
      return 1;
    case 'timed_out':
      return 2;
    default:
      return 3;
  }
}

async function main(): Promise<void> {
  const args = parsePollArgs(process.argv.slice(2));
  const repoRoot = process.env.REPO_ROOT ?? process.cwd();
  const container = composeRoot({
    repoRoot,
    scriptPath: 'scripts/ai-run-issue-v2',
    runStartupSweeps: false,
  });
  const poller = container.buildPrReviewPoller({
    maxPolls: args.maxPolls,
    pollIntervalMs: args.pollIntervalSeconds * 1000,
    readyMaxDays: 7,
    phaseStartedAt: new Date(),
  });
  const runIdStr = args.runId ?? process.env.AI_RUN_UUID ?? crypto.randomUUID();
  const result = await poller.run({
    runId: RunId(runIdStr),
    repoId: RepositoryId(args.repoFullName),
    repoFullName: args.repoFullName,
    prNumber: args.prNumber,
    cwd: args.cwd,
    phaseId: PhaseName('post-pr-review'),
  });
  process.stderr.write(`[run-pr-poll] terminal=${result.terminalState} polls=${result.pollsRun}\n`);
  process.exit(exitCodeForTerminalState(result.terminalState));
}

if (!process.env.VITEST) {
  void main().catch((err) => {
    process.stderr.write(`[run-pr-poll] fatal: ${String(err)}\n`);
    process.exit(3);
  });
}

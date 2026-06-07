#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { composeRoot } from '@ai-sdlc/api/compose.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type { PollerTerminalState, RunRepositoryPort } from '@ai-sdlc/application';
import { createRun, RepositoryId, RunId, PhaseName } from '@ai-sdlc/domain';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

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

export interface RunPollDeps {
  eventBus: {
    subscribe(runUuid: string, listener: (event: OrchestratorEvent) => void): () => void;
  };
  runRepository: RunRepositoryPort & { insert(run: import('@ai-sdlc/domain').Run): void };
  buildPrReviewPoller: (opts: {
    maxPolls: number;
    pollIntervalMs: number;
    readyMaxDays: number;
    phaseStartedAt: Date;
  }) => {
    run(input: {
      runId: RunId;
      repoId: RepositoryId;
      repoFullName: string;
      prNumber: number;
      cwd: string;
      phaseId: PhaseName;
    }): Promise<{ terminalState: PollerTerminalState; pollsRun: number }>;
  };
  stderr: NodeJS.WritableStream;
  repoRoot: string;
}

export function formatEvent(event: OrchestratorEvent): string {
  const ts = event.timestamp.replace(/^.*T(\d{2}:\d{2}:\d{2}).*$/, '$1');
  const meta =
    event.metadata && Object.keys(event.metadata).length > 0
      ? ' ' +
        Object.entries(event.metadata)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(' ')
      : '';
  return `[${ts}] [${event.type}] ${event.message}${meta}\n`;
}

export async function runPoll(args: PollArgs, deps: RunPollDeps): Promise<number> {
  const runIdStr = args.runId ?? crypto.randomUUID();

  deps.stderr.write(
    `[run-pr-poll] PID: ${process.pid} PR: ${args.prNumber} max_polls: ${args.maxPolls} interval: ${args.pollIntervalSeconds}s\n`,
  );

  const existing = deps.runRepository.findByUuid(runIdStr);
  if (!existing) {
    const run = createRun({
      uuid: runIdStr,
      displayId: `poll-pr-${args.prNumber}-${Date.now()}`,
      issueNumber: args.issueNumber ?? 0,
      type: 'pr_review',
      startedAt: new Date(),
    });
    try {
      deps.runRepository.insert(run);
    } catch {
      // Race: orchestrator may have inserted between findByUuid and insert — that's fine
    }
  }

  const poller = deps.buildPrReviewPoller({
    maxPolls: args.maxPolls,
    pollIntervalMs: args.pollIntervalSeconds * 1000,
    readyMaxDays: 7,
    phaseStartedAt: new Date(),
  });

  const unsubscribe = deps.eventBus.subscribe(runIdStr, (event) => {
    try {
      deps.stderr.write(formatEvent(event));
    } catch {
      // Best-effort: stderr write must not crash the poller
    }
  });

  try {
    const result = await poller.run({
      runId: RunId(runIdStr),
      repoId: RepositoryId(args.repoFullName),
      repoFullName: args.repoFullName,
      prNumber: args.prNumber,
      cwd: args.cwd,
      phaseId: PhaseName('post-pr-review'),
    });
    deps.stderr.write(`[run-pr-poll] terminal=${result.terminalState} polls=${result.pollsRun}\n`);
    return exitCodeForTerminalState(result.terminalState);
  } finally {
    unsubscribe();
    for (const candidate of ['result.json', join('apps', 'cli', 'result.json')]) {
      try {
        const p = join(deps.repoRoot, candidate);
        if (existsSync(p)) unlinkSync(p);
      } catch {
        // Best-effort cleanup
      }
    }
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
  const exitCode = await runPoll(args, {
    eventBus: container.eventBus,
    runRepository: container.runRepository as RunPollDeps['runRepository'],
    buildPrReviewPoller: container.buildPrReviewPoller,
    stderr: process.stderr,
    repoRoot,
  });
  process.exit(exitCode);
}

if (!process.env.VITEST) {
  void main().catch((err) => {
    process.stderr.write(`[run-pr-poll] fatal: ${String(err)}\n`);
    process.exit(3);
  });
}

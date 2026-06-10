import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  openDatabase,
  applyMigrations,
  RunRepository,
  PhaseRepository,
  EventRepository,
  ArtifactRepository,
  FailureRepository,
  AgentInvocationRepository,
  ValidationRunRepository,
  PrReviewRepository,
  RunDirectory,
  runBashScript,
  classifyExit,
  InMemoryEventBus,
  EventTailer,
  ProcessValidationAdapter,
  GhCliAdapter,
} from '@ai-sdlc/infrastructure';
import {
  StartIssueRun,
  CancelRun,
  SweepOrphanedRuns,
  checkPid,
  RunValidation,
  PrReviewPoller,
  ProcessPrReviewComments,
  postPrReviewResultSchema,
  type StartIssueRunDeps,
  type ClassifyExitFn,
  type EventTailerFactory,
  type EventBusPort,
  type RunRepositoryPort,
  type TmpDirectoryFactory,
  type GitPort,
  type CreateWorktreeInput,
  type PushInput,
} from '@ai-sdlc/application';
import { ConfigError, loadConfig, PHASE_FALLBACKS, type AgentConfig } from '@ai-sdlc/shared';
import { AgentProfileName, PhaseName, RunId } from '@ai-sdlc/domain';
import {
  AgentRuntimeRouter,
  OpenCodeAgentAdapter,
  PiAgentAdapter,
  AntigravityAgentAdapter,
  ClaudeCodeAgentAdapter,
} from '@ai-sdlc/infrastructure';

const classifyExitAdapter = (
  agentInvocationRepository: AgentInvocationRepository,
): ClassifyExitFn => {
  return (input) => {
    let enriched = input;
    try {
      const invocations = agentInvocationRepository.listByRun(RunId(input.runUuid));
      const latest = invocations[invocations.length - 1];
      if (latest && latest.outcome && latest.outcome !== 'success') {
        let stderrContent: string | undefined;
        if (latest.stderrPath) {
          try {
            stderrContent = readFileSync(latest.stderrPath, 'utf-8');
          } catch {}
        }
        enriched = {
          ...input,
          invocation: {
            outcome: latest.outcome,
            phaseId: latest.phaseId,
            ...(stderrContent !== undefined ? { stderrContent } : {}),
            ...(latest.contractViolations !== undefined
              ? { contractViolations: latest.contractViolations }
              : {}),
          },
        };
      }
    } catch (err) {
      console.error(`Failed to enrich classifyExit with invocation data:`, err);
    }
    return classifyExit(enriched);
  };
};

/**
 * Resolve the agent profile name for a given phase.
 * Throws `ConfigError` if the phase is not configured or agent config is absent.
 */
export function resolveProfileForPhase(agent: AgentConfig, phaseName: string): AgentProfileName {
  let entry = agent.phaseProfiles[phaseName];
  if (!entry) {
    const fallback = PHASE_FALLBACKS[phaseName];
    if (fallback) {
      entry = agent.phaseProfiles[fallback];
      if (entry) phaseName = fallback;
    }
  }
  if (!entry) {
    throw new ConfigError(`unknown phase '${phaseName}'`);
  }
  if (!entry.profile) {
    throw new ConfigError(`phase '${phaseName}' has no profile configured`);
  }
  return AgentProfileName(entry.profile);
}

export interface Container {
  runRepository: RunRepository;
  phaseRepository: PhaseRepository;
  eventRepository: EventRepository;
  artifactRepository: ArtifactRepository;
  failureRepository: FailureRepository;
  agentInvocationRepository: AgentInvocationRepository;
  validationRunRepository: ValidationRunRepository;
  prReviewRepository: PrReviewRepository;
  runValidation: RunValidation;
  startIssueRun: StartIssueRun;
  cancelRun: CancelRun;
  runsDir: string;
  baseTmpDir: string;
  eventBus: EventBusPort;
  /** @deprecated Use `resolveProfileForPhase()` instead */
  agentRuntime?: AgentRuntimeRouter;
  resolveProfileForPhase: (phaseName: string) => AgentProfileName;
  buildPrReviewPoller: (opts: {
    maxPolls: number;
    pollIntervalMs: number;
    readyMaxDays: number;
    phaseStartedAt: Date;
    baseBranch?: string;
  }) => PrReviewPoller;
}

export interface ComposeOptions {
  repoRoot: string;
  scriptPath: string;
  baseBranch?: string;
  model?: string;
  agentCli?: string;
  tee?: boolean;
  dbPath?: string;
  runsDir?: string;
  baseTmpDir?: string;
  /** Run orphan sweeps on compose. Defaults to true. Set to false when
   *  composing inside a child process that owns a tmp dir the sweep
   *  would delete out from under it (e.g. run-agent.ts). */
  runStartupSweeps?: boolean;
}

export function composeRoot(opts: ComposeOptions): Container {
  const runsDir = opts.runsDir ?? join(opts.repoRoot, '.ai-runs');
  const envTmpdir = process.env.TMPDIR?.trim();
  const baseTmpDir =
    opts.baseTmpDir ?? (envTmpdir ? join(envTmpdir, '.ai-tmp') : join(dirname(runsDir), '.ai-tmp'));
  mkdirSync(baseTmpDir, { recursive: true });
  const db = openDatabase(opts.dbPath ?? join(runsDir, 'orchestrator.sqlite'));
  applyMigrations(db);
  const runRepository = new RunRepository(db);

  if (opts.runStartupSweeps !== false) {
    // Sweep orphaned runs before any new run starts
    const sweep = new SweepOrphanedRuns({
      runRepository,
      isProcessAlive: checkPid,
    });
    const sweepResult = sweep.execute();
    if (sweepResult.swept > 0) {
      console.error(`Recovered ${sweepResult.swept} orphaned run(s)`);
    }

    // Sweep orphaned tmp dirs: remove .ai-tmp/<runId>/ where the runId
    // has no active or recent run, or the run is in a terminal state.
    sweepOrphanedTmpDirs(baseTmpDir, runRepository);
  }

  const phaseRepository = new PhaseRepository(db);
  const eventRepository = new EventRepository(db);
  const artifactRepository = new ArtifactRepository(db);
  const failureRepository = new FailureRepository(db);
  const agentInvocationRepository = new AgentInvocationRepository(db);
  const validationRunRepository = new ValidationRunRepository(db);
  const prReviewRepository = new PrReviewRepository(db);
  const validationAdapter = new ProcessValidationAdapter();
  const runValidation = new RunValidation({
    validation: validationAdapter,
    validationRunRepository,
    failureRepository,
    idFactory: () => randomUUID(),
    now: () => new Date(),
  });
  const eventBus = new InMemoryEventBus();
  const createEventTailer: EventTailerFactory = (input) => new EventTailer(input);

  const tmpDirectoryFactory: TmpDirectoryFactory = ({ baseTmpDir: base, runId }) => {
    const tmpDir = join(base, runId);
    mkdirSync(tmpDir, { recursive: true });
    return {
      tmpDir,
      remove() {
        rmSync(tmpDir, { recursive: true, force: true });
      },
    };
  };

  const deps: StartIssueRunDeps = {
    runRepository,
    failureRepository,
    classifyExit: classifyExitAdapter(agentInvocationRepository),
    runDirectoryFactory: ({ rootDir, run }) => RunDirectory.create({ rootDir, run }),
    runBashScript,
    runsDir,
    scriptPath: opts.scriptPath,
    eventRepository,
    eventBus,
    createEventTailer,
    baseTmpDir,
    tmpDirectoryFactory,
  };
  if (opts.baseBranch !== undefined) deps.baseBranch = opts.baseBranch;
  if (opts.model !== undefined) deps.model = opts.model;
  if (opts.agentCli !== undefined) deps.agentCli = opts.agentCli;
  if (opts.tee !== undefined) deps.tee = opts.tee;
  const startIssueRun = new StartIssueRun(deps);
  const cancelRun = new CancelRun({ runRepository });

  // Resolve the repo's default branch eagerly (L7). Falls back to 'main' on error.
  let resolvedDefaultBranch = 'main';
  try {
    const out = execFileSync('gh', [
      'repo',
      'view',
      '--json',
      'defaultBranchRef',
      '-q',
      '.defaultBranchRef.name',
    ])
      .toString()
      .trim();
    if (out) resolvedDefaultBranch = out;
  } catch {
    // Best-effort: fall back to 'main'
  }

  let agentRuntime: AgentRuntimeRouter | undefined;
  let resolveProfileForPhaseBound: ((phaseName: string) => AgentProfileName) | undefined;
  try {
    const config = loadConfig(opts.repoRoot);
    if (config.agent) {
      const needsPi = Object.values(config.agent.profiles).some((p) => p.runtime === 'pi');
      const adapters: Partial<
        Record<import('@ai-sdlc/domain').AgentRuntimeKind, import('@ai-sdlc/application').AgentPort>
      > = {
        opencode: new OpenCodeAgentAdapter({
          artifactsDir: join(runsDir, 'agent-artifacts'),
        }),
      };
      if (needsPi) {
        adapters.pi = new PiAgentAdapter({
          artifactsDir: join(runsDir, 'agent-artifacts'),
        });
      }
      const needsAntigravity = Object.values(config.agent.profiles).some(
        (p) => p.runtime === 'antigravity',
      );
      if (needsAntigravity) {
        adapters.antigravity = new AntigravityAgentAdapter({
          artifactsDir: join(runsDir, 'agent-artifacts'),
        });
      }
      const needsClaudeCode = Object.values(config.agent.profiles).some(
        (p) => p.runtime === 'claude-code',
      );
      if (needsClaudeCode) {
        adapters['claude-code'] = new ClaudeCodeAgentAdapter({
          artifactsDir: join(runsDir, 'agent-artifacts'),
        });
      }
      agentRuntime = new AgentRuntimeRouter({
        agent: config.agent,
        adapters,
        invocationRepository: agentInvocationRepository,
        eventBus,
      });
      const agent = config.agent;
      resolveProfileForPhaseBound = (phaseName: string) => resolveProfileForPhase(agent, phaseName);
    }
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    if ((err.cause as { code?: string })?.code !== 'ENOENT') throw err;
  }

  const defaultResolve: (phaseName: string) => AgentProfileName = (_phaseName: string) => {
    throw new ConfigError('no agent config');
  };

  function buildPrReviewPoller(opts: {
    maxPolls: number;
    pollIntervalMs: number;
    readyMaxDays: number;
    phaseStartedAt: Date;
    baseBranch?: string;
    repoRoot?: string;
  }): PrReviewPoller {
    if (!agentRuntime) {
      throw new ConfigError(
        'agent config required for PR review poller; configure .ai-sdlc/config.yaml',
      );
    }
    const ghAdapter = new GhCliAdapter({});
    // GitPort audit: ProcessPrReviewComments uses git.diff, git.headCommitSha,
    // git.headCommitShaOf, git.remoteRef, git.isAncestor, git.logBetween,
    // git.resetHard, and git.cleanUntracked. The remaining methods
    // (createWorktree, removeWorktree, currentBranch, commit, push) are stubs that throw with a clear message
    // — they must not be called from the PR review poller flow.
    const gitAdapter: GitPort = {
      async createWorktree(_input: CreateWorktreeInput): Promise<void> {
        throw new Error(
          'GitPort.createWorktree is not wired in compose poller (PR review flow does not create worktrees)',
        );
      },
      async removeWorktree(_worktreePath: string): Promise<void> {
        throw new Error(
          'GitPort.removeWorktree is not wired in compose poller (PR review flow does not remove worktrees)',
        );
      },
      async currentBranch(_cwd: string): Promise<string> {
        throw new Error(
          'GitPort.currentBranch is not wired in compose poller (PR review flow does not query branch)',
        );
      },
      async headCommitSha(cwd: string): Promise<string> {
        const { execFileSync } = await import('node:child_process');
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd }).toString().trim();
      },
      // Best-effort variant of headCommitSha: returns undefined instead of
      // throwing so the main-checkout drift guard can silently skip when the
      // repo root is missing or not a git dir, rather than failing the poll.
      async headCommitShaOf(cwd: string): Promise<string | undefined> {
        try {
          const { execFileSync } = await import('node:child_process');
          return execFileSync('git', ['rev-parse', 'HEAD'], { cwd }).toString().trim();
        } catch {
          return undefined;
        }
      },
      async resetHard(cwd: string, commitSha: string): Promise<void> {
        const { execFileSync } = await import('node:child_process');
        execFileSync('git', ['reset', '--hard', commitSha], { cwd });
      },
      async diff(_cwd: string, _base: string, _head?: string): Promise<string> {
        const { execFileSync } = await import('node:child_process');
        const args = _head ? [`${_base}...${_head}`] : [_base];
        try {
          return execFileSync('git', ['diff', ...args], { cwd: _cwd }).toString();
        } catch (err) {
          process.stderr.write(
            `[compose] git diff ${args.join(' ')} failed in ${_cwd}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          return '';
        }
      },
      async commit(_cwd: string, _message: string): Promise<string> {
        throw new Error(
          'GitPort.commit is not wired in compose poller (PR review flow does not commit via this adapter)',
        );
      },
      async push(_input: PushInput): Promise<void> {
        throw new Error(
          'GitPort.push is not wired in compose poller (PR review flow does not push via this adapter)',
        );
      },
      async remoteRef(input: {
        cwd: string;
        remote: string;
        ref: string;
      }): Promise<string | undefined> {
        try {
          const { execFileSync } = await import('node:child_process');
          const output = execFileSync('git', ['ls-remote', input.remote, input.ref], {
            cwd: input.cwd,
          })
            .toString()
            .trim();
          return output.split(/\s+/)[0] || undefined;
        } catch {
          return undefined;
        }
      },
      async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
        try {
          const { execFileSync } = await import('node:child_process');
          execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
            cwd,
          });
          return true;
        } catch (err) {
          process.stderr.write(
            `[compose] git merge-base --is-ancestor ${ancestor} ${descendant} failed in ${cwd}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          return false;
        }
      },
      async logBetween(cwd: string, base: string, head: string): Promise<string[]> {
        try {
          const { execFileSync } = await import('node:child_process');
          const output = execFileSync('git', ['log', '--format=%H', `${base}..${head}`], {
            cwd,
          })
            .toString()
            .trim();
          return output ? output.split('\n') : [];
        } catch {
          return [];
        }
      },
      async cleanUntracked(cwd: string): Promise<void> {
        const { execFileSync } = await import('node:child_process');
        execFileSync('git', ['clean', '-fd'], { cwd });
      },
    };
    const processor = new ProcessPrReviewComments({
      github: ghAdapter,
      git: gitAdapter,
      agent: agentRuntime,
      prReviewRepo: prReviewRepository,
      renderPrompt: async ({ cwd: _cwd, comments, diff, branch }) => {
        const promptDir = join(baseTmpDir, 'pr-review-prompt');
        mkdirSync(promptDir, { recursive: true });
        const promptPath = join(promptDir, 'prompt.md');
        const content = [
          '# PR Review Task',
          '',
          'Review and address the following PR review comments:',
          '',
          ...comments.map((c) => `- [commentId: ${c.commentId}] ${c.path}:${c.line} — ${c.body}`),
          '',
          '## Current Diff',
          '',
          diff,
          '',
          '## Instructions',
          '',
          'For each review comment, make a judgement call: is it technically valid?',
          '',
          'For comments that require code changes:',
          '1. Edit the relevant source files',
          '2. Stage and commit your changes:',
          '   ```',
          '   git add -A',
          '   git commit -m "fix: address PR review feedback"',
          '   ```',
          `3. Push to the PR branch: \`git push origin '${branch.replace(/'/g, "'\\''")}'\``,
          '',
          'For comments assessed as invalid, no code changes are needed — include your reasoning in replyBody below.',
          '',
          'IMPORTANT: Do NOT post replies yourself (no `gh api` calls for replies). The orchestrator',
          'handles posting replies from the replyBody fields in your result.json.',
          '',
          '## Required Output',
          '',
          'When done, write a `result.json` file with this exact shape:',
          '```json',
          '{',
          '  "outcome": "ALL_DONE" | "NO_FIXES_NEEDED" | "PARTIAL" | "BLOCKED",',
          '  "comments": [',
          '    {',
          '      "commentId": <number — must match a commentId from the list above>,',
          '      "action": "fixed" | "no_fix" | "blocked",',
          '      "replyBody": "<non-empty string explaining your decision>",',
          '      "blockedReason": "<string — only when action is blocked>"',
          '    }',
          '  ]',
          '}',
          '```',
          '',
          'Every commentId from the list above MUST appear in the comments array.',
        ].join('\n');
        writeFileSync(promptPath, content, 'utf-8');
        return promptPath;
      },
      extractResult: async (input) => {
        try {
          const absPath = input.resultJsonPath
            ? join(input.cwd, input.resultJsonPath)
            : join(input.cwd, 'result.json');
          const raw = readFileSync(absPath, 'utf-8');
          const parsed = JSON.parse(raw);
          const result = postPrReviewResultSchema.safeParse(parsed);
          if (!result.success) {
            return { ok: false, reason: 'invalid', detail: result.error.message };
          }
          return { ok: true, result: result.data };
        } catch (err) {
          return { ok: false, reason: 'missing', detail: String(err) };
        }
      },
      verifyCommitPushed: async ({ cwd, branch, startCommitSha, commitSha }) => {
        try {
          const remoteSha = await gitAdapter.remoteRef({ cwd, remote: 'origin', ref: branch });
          if (!remoteSha) return false;
          if (commitSha) {
            const onRemote = await gitAdapter.isAncestor(cwd, commitSha, remoteSha);
            if (!onRemote) return false;
            const isNewer = await gitAdapter.logBetween(cwd, startCommitSha, commitSha);
            return isNewer.length > 0;
          }
          return false;
        } catch {
          return false;
        }
      },
      verifyBuildPasses: async ({ cwd, runId }) => {
        try {
          const config = loadConfig(cwd);
          if (!config.validation?.commands?.length) {
            try {
              eventRepository.insert({
                runUuid: runId,
                phase: 'post-pr-review',
                level: 'warn',
                type: 'post-pr-review.build_verification_skipped',
                message: 'build verification skipped: no validation.commands configured',
                metadata: { cwd },
                timestamp: new Date(),
              });
            } catch {}
            return true;
          }
          const buildCheckRunId = RunId(`pr-review-build-check-${randomUUID()}`);
          const logDir = join(runsDir, buildCheckRunId);
          const result = await runValidation.execute({
            runId: buildCheckRunId,
            phaseId: PhaseName('post-pr-review'),
            cwd,
            logDir,
            commands: config.validation.commands,
            timeoutSeconds: config.validation.timeout,
          });
          return result.passed;
        } catch {
          return false;
        }
      },
      resolveProfileForPhase: resolveProfileForPhaseBound ?? defaultResolve,
      idFactory: () => randomUUID(),
      now: () => new Date(),
      baseBranch: opts.baseBranch ?? resolvedDefaultBranch,
      repoRoot: opts.repoRoot,
      onWarning: (message, metadata, runId) => {
        try {
          eventRepository.insert({
            runUuid: runId,
            phase: 'post-pr-review',
            level: 'warn',
            type: 'post-pr-review.main_checkout_guard',
            message,
            metadata,
            timestamp: new Date(),
          });
        } catch {}
      },
    });
    // Wrap the in-memory bus so poll events are persisted to the database.
    // In the detached CLI process there are no SSE subscribers, so without
    // this wrapper post-pr-review.poll.* events would vanish.
    const persistingEventBus: EventBusPort = {
      subscribe: (runUuid, listener) => eventBus.subscribe(runUuid, listener),
      publish: (runUuid, event) => {
        eventBus.publish(runUuid, event);
        try {
          eventRepository.insert({
            runUuid,
            ...(event.phase !== undefined ? { phase: event.phase } : {}),
            level: event.level,
            type: event.type,
            message: event.message,
            ...(event.metadata !== undefined
              ? { metadata: event.metadata as Record<string, unknown> }
              : {}),
            timestamp: new Date(event.timestamp),
          });
        } catch {
          // Best-effort: event persistence must not crash the poller
        }
      },
    };
    return new PrReviewPoller({
      prReviewRepo: prReviewRepository,
      processOnePass: async (input) => {
        const output = await processor.execute(input);
        const attempts = prReviewRepository.listPollAttempts(input.runId);
        const lastAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
        return {
          result: {
            outcome: output.outcome,
            processed: output.processed,
            blocked: output.blocked,
            allResolved: output.allResolved,
            rateLimited: false,
          },
          attempt: lastAttempt,
        };
      },
      eventBus: persistingEventBus,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => new Date(),
      maxPolls: opts.maxPolls,
      pollIntervalMs: opts.pollIntervalMs,
      readyMaxDays: opts.readyMaxDays,
      phaseStartedAt: opts.phaseStartedAt,
      recordTerminalState: async (attempt, state, nextPollAt) => {
        if (attempt) {
          prReviewRepository.updatePollAttempt({
            ...attempt,
            ...(attempt.status === 'running' && state !== 'running' ? { status: 'completed' } : {}),
            ...(state !== 'running' ? { terminalState: state, completedAt: new Date() } : {}),
            ...(nextPollAt ? { nextPollAt } : {}),
          });
        }
      },
    });
  }

  return {
    runRepository,
    phaseRepository,
    eventRepository,
    artifactRepository,
    failureRepository,
    agentInvocationRepository,
    validationRunRepository,
    prReviewRepository,
    runValidation,
    startIssueRun,
    cancelRun,
    runsDir,
    baseTmpDir,
    eventBus,
    ...(agentRuntime ? { agentRuntime } : {}),
    resolveProfileForPhase: resolveProfileForPhaseBound ?? defaultResolve,
    buildPrReviewPoller,
  };
}

function sweepOrphanedTmpDirs(baseTmpDir: string, runRepository: RunRepositoryPort): void {
  if (!existsSync(baseTmpDir)) return;
  const entries = readdirSync(baseTmpDir);
  for (const entry of entries) {
    const entryPath = join(baseTmpDir, entry);
    try {
      const stat = statSync(entryPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    const record = runRepository.findByUuid(entry);
    if (!record) continue;
    if (['passed', 'failed', 'cancelled'].includes(record.status)) {
      try {
        rmSync(entryPath, { recursive: true, force: true });
      } catch {
        // Best-effort: if removal fails (e.g., file in use), leave for next sweep
      }
    }
  }
}

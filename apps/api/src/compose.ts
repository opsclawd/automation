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
  copyFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  openDatabase,
  applyMigrations,
  RunRepository,
  PhaseRepository,
  EventRepository,
  ArtifactRepository,
  FailureRepository,
  LoopRepository,
  AgentInvocationRepository,
  ValidationRunRepository,
  PrReviewRepository,
  AgentUsageRepository,
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
  decideReactivation,
  applyReactivation,
  pollTaskResultSchema,
  ReviewFixLoop,
  ImplementStepLoop,
  readReviewVerdict,
  readFixVerdict,
  PhaseHandlerRegistry,
  RunExecutor,
  HandlerNotWiredError,
  CANONICAL_PHASE_ORDER,
  type ArtifactStore,
  type StartIssueRunDeps,
  type ClassifyExitFn,
  type EventTailerFactory,
  type EventBusPort,
  type RunRepositoryPort,
  type TmpDirectoryFactory,
  type GitPort,
  type CreateWorktreeInput,
  type PushInput,
  type StepContext,
  type ReviewStepResult,
  type FixStepResult,
  type RevalidationResult,
  type PhaseHandlerContext,
  type PhaseHandlerContextFactory,
  type ImplementStepLoop as ImplementStepLoopType,
  type StepLoopContext,
  type FixStepOptions,
  type TypecheckResult,
  type ResolveRefShaFn,
} from '@ai-sdlc/application';
import { ConfigError, loadConfig, PHASE_FALLBACKS, type AgentConfig } from '@ai-sdlc/shared';
import {
  AgentProfileName,
  AgentInvocationId,
  PhaseName,
  RunId,
  RepositoryId,
} from '@ai-sdlc/domain';
import {
  AgentRuntimeRouter,
  OpenCodeAgentAdapter,
  PiAgentAdapter,
  AntigravityAgentAdapter,
  ClaudeCodeAgentAdapter,
  CodexAgentAdapter,
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
  phaseRegistry: PhaseHandlerRegistry;
  runExecutor?: RunExecutor;
  eventRepository: EventRepository;
  artifactRepository: ArtifactRepository;
  failureRepository: FailureRepository;
  agentInvocationRepository: AgentInvocationRepository;
  validationRunRepository: ValidationRunRepository;
  prReviewRepository: PrReviewRepository;
  loopRepository: LoopRepository;
  runValidation: RunValidation;
  startIssueRun: StartIssueRun;
  cancelRun: CancelRun;
  runsDir: string;
  baseTmpDir: string;
  defaultBranch: string;
  eventBus: EventBusPort;
  /** @deprecated Use `resolveProfileForPhase()` instead */
  agentRuntime?: AgentRuntimeRouter;
  resolveProfileForPhase: (phaseName: string) => AgentProfileName;
  buildPhaseHandlerContext: PhaseHandlerContextFactory;
  reviewFixLoop?: ReviewFixLoop;
  implementStepLoop?: ImplementStepLoopType;
  runStep?: (sctx: {
    stepIndex: number;
    stepTitle: string;
    cwd: string;
    ctx: import('@ai-sdlc/application').PhaseHandlerContext;
  }) => Promise<{ outcome: 'success' | 'failed' }>;
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

class AbortRegistry {
  private readonly entries = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();

  register(runId: string, controller: AbortController, done: Promise<void>): void {
    this.entries.set(runId, { controller, done });
  }

  async abort(runId: string): Promise<void> {
    const entry = this.entries.get(runId);
    if (entry) {
      entry.controller.abort();
      let timer: NodeJS.Timeout;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 30_000);
      });
      await Promise.race([entry.done.catch(() => {}), timeout]).finally(() => clearTimeout(timer));
    }
  }

  unregister(runId: string): void {
    this.entries.delete(runId);
  }
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
  const agentUsageRepository = new AgentUsageRepository(db);
  const loopRepository = new LoopRepository(db);
  const validationAdapter = new ProcessValidationAdapter();
  const runValidation = new RunValidation({
    validation: validationAdapter,
    validationRunRepository,
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
  deps.resolveRefSha = ((cwd: string, ref: string) => {
    try {
      return execFileSync('git', ['rev-parse', ref], { cwd }).toString().trim() || undefined;
    } catch {
      return undefined;
    }
  }) satisfies ResolveRefShaFn;
  const startIssueRun = new StartIssueRun(deps);
  const logger: { error: (message: string, ...args: unknown[]) => void } = {
    error: (msg, ...args) => console.error(msg, ...args),
  };

  const abortRegistry = new AbortRegistry();

  const cancelRun = new CancelRun({
    runRepository,
    logger,
    runAbort: abortRegistry,
    git: {
      createWorktree: async () => {},
      removeWorktree: async () => {},
      currentBranch: async () => '',
      headCommitSha: async () => '',
      resetHard: (cwd: string, commitSha: string) => {
        execFileSync('git', ['reset', '--hard', commitSha], { cwd });
        return Promise.resolve();
      },
      diff: async () => '',
      commit: async () => '',
      push: async () => {},
      remoteRef: async () => undefined,
      isAncestor: async () => false,
      logBetween: async () => [],
      cleanUntracked: (cwd: string) => {
        // -x also removes worktree-ignored orchestrator artifacts (result.json,
        // *.md, *.result, logs) that the script seeds into .git/info/exclude, so
        // a cancelled/reset run can't leak stale results into the next run on the
        // reused worktree. node_modules is excluded to avoid an expensive reinstall.
        execFileSync('git', ['clean', '-fdx', '-e', 'node_modules'], { cwd });
        return Promise.resolve();
      },
      headCommitShaOf: async () => undefined,
    },
    // TODO(#388): Wire WorkerLeaseRepository once the lease infrastructure is ready.
    // `acquire` throws because CancelRun should never need to acquire — leases are
    // acquired by run-start/resume flows. `release` is a noop (tracked in #388).
    leases: {
      acquire: () => {
        throw new Error('leases not wired in compose');
      },
      heartbeat: () => {},
      release: () => {},
      current: () => undefined,
      reclaimExpired: () => [],
    },
    findCwd: (runId: RunId) => {
      const run = runRepository.findByUuid(runId);
      if (!run) throw new Error(`findCwd: no run found for ${runId}`);
      return join(opts.repoRoot, '.ai-worktrees', `issue-${run.issueNumber}`);
    },
    findStartCommitSha: (runId: RunId) => {
      const run = runRepository.findByUuid(runId);
      if (!run) return 'HEAD';
      if (run.startCommitSha) return run.startCommitSha;
      // Resolve from the worktree's branch at cancel time.
      // The issue branch (`ai/issue-<n>`, per scripts/ai-run-issue-v2) was
      // created from origin/<defaultBranch>; the merge base gives the original
      // commit even if origin/<defaultBranch> has advanced since worktree
      // creation. This avoids capturing the SHA from repoRoot before the
      // worktree exists (which could be stale).
      const branchName = `ai/issue-${run.issueNumber}`;
      try {
        const sha = execFileSync(
          'git',
          ['merge-base', branchName, `origin/${resolvedDefaultBranch}`],
          { cwd: opts.repoRoot },
        )
          .toString()
          .trim();
        if (sha) return sha;
      } catch {
        // Fall through to HEAD
      }
      return 'HEAD';
    },
    // findRepoId resolves the repo full name at compose time via `gh repo view`.
    // Returns undefined when unresolved so CancelRun's best-effort cleanups skip
    // cleanly instead of throwing. Full run→repo wiring lands in #388.
    findRepoId: (_runId: RunId): RepositoryId | undefined =>
      resolvedRepoFullName ? (resolvedRepoFullName as RepositoryId) : undefined,
  });

  // TODO(#388): Wire ResumeRun and RetryFailedPhase use cases with their
  // infrastructure dependencies.
  // const resumeRun = new ResumeRun({ ... });
  // const retryFailedPhase = new RetryFailedPhase({ ... });

  const phaseRegistry = new PhaseHandlerRegistry();
  for (const phaseName of CANONICAL_PHASE_ORDER) {
    phaseRegistry.register({
      phase: phaseName,
      run: async () => {
        throw new HandlerNotWiredError(phaseName as string);
      },
    });
  }

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

  // Resolve repo full name eagerly for findRepoId in cancel flow.
  let resolvedRepoFullName: string | undefined;
  try {
    const out = execFileSync(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      { cwd: opts.repoRoot },
    )
      .toString()
      .trim();
    if (out) resolvedRepoFullName = out;
  } catch (err) {
    console.error(`CancelRun: failed to resolve repo full name for ${opts.repoRoot}`, err);
  }

  let agentRuntime: AgentRuntimeRouter | undefined;
  let resolveProfileForPhaseBound: ((phaseName: string) => AgentProfileName) | undefined;
  let reviewFixLoop: ReviewFixLoop | undefined;
  let implementStepLoop: ImplementStepLoopType | undefined;
  let runStep: Container['runStep'] | undefined;
  let runExecutor: RunExecutor | undefined;
  try {
    const config = loadConfig(opts.repoRoot);
    if (config.agent) {
      const needsPi = Object.values(config.agent.profiles).some((p) => p.runtime === 'pi');
      const adapters: Partial<
        Record<import('@ai-sdlc/domain').AgentRuntimeKind, import('@ai-sdlc/application').AgentPort>
      > = {
        opencode: new OpenCodeAgentAdapter({
          artifactsDir: join(runsDir, 'agent-artifacts'),
          repoRoot: opts.repoRoot,
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
      const needsCodex = Object.values(config.agent.profiles).some((p) => p.runtime === 'codex');
      if (needsCodex) {
        adapters.codex = new CodexAgentAdapter({
          artifactsDir: join(runsDir, 'agent-artifacts'),
        });
      }
      agentRuntime = new AgentRuntimeRouter({
        agent: config.agent,
        adapters,
        invocationRepository: agentInvocationRepository,
        usageRepository: agentUsageRepository,
        eventBus,
      });
      const agent = config.agent;
      resolveProfileForPhaseBound = (phaseName: string) => resolveProfileForPhase(agent, phaseName);

      const router = agentRuntime;
      const reviewProfileName: string =
        config.agent.phaseProfiles['whole-pr-review']?.profile ?? 'opencode-frontier';
      const fixProfileName: string =
        config.agent.phaseProfiles['fix-review']?.profile ?? 'opencode-frontier';
      const fixFallbackProfileName: string | undefined =
        config.agent.phaseProfiles['fix-review']?.fallbackProfile;

      const newestInvocationId = (runUuid: string): string => {
        const list = agentInvocationRepository.listByRun(RunId(runUuid));
        const last = list[list.length - 1];
        return last ? String(last.id) : '';
      };

      const runReview = async (ctx: StepContext): Promise<ReviewStepResult> => {
        const runDir = runRepository.findByUuid(String(ctx.runId))?.displayId ?? String(ctx.runId);
        const promptDir = join(baseTmpDir, 'review-fix-prompts');
        mkdirSync(promptDir, { recursive: true });
        const promptPath = join(promptDir, `review-${String(ctx.runId)}-${ctx.iterationIndex}.md`);
        const reviewPrompt = [
          'You are reviewing code changes in a pull request.',
          '',
          '## CONTEXT',
          `Working directory: ${ctx.cwd}`,
          `Repository: ${ctx.repoId}`,
          '',
          '## TASK',
          `Run: git diff origin/${opts.baseBranch ?? resolvedDefaultBranch}...HEAD`,
          'Read the diff carefully.',
          '',
          'Write a code review to ./code-review.md.',
          '',
          'For each finding you MUST include:',
          '- severity: critical | high | medium | low',
          '- file path and line reference (if applicable)',
          '- evidence: what you observed in the diff',
          '- failure mode: why this is a problem',
          '- required fix: specific action to resolve the issue',
          '',
          'Categorize findings:',
          '- critical: security, data loss, production-breaking',
          '- high: correct behavior violation, significant bugs',
          '- medium: suboptimal patterns, missing tests',
          '- low: style, formatting, minor improvements',
          '',
          'After writing the review, write a result.json file with:',
          '{ "result": "pass" | "fail", "findings": [{ "severity": "...", "summary": "..." }] }',
          'Use "pass" when there are no significant findings, "fail" when changes are needed.',
          '',
          '## CRITICAL RULES',
          '- Do NOT ask questions.',
          '- Do NOT switch branches. All work must stay on the current branch.',
          '- Do NOT write any other files. No scratch files, no `git diff > file`, no temporary files.',
          '- Write code-review.md first, then result.json.',
        ].join('\n');
        writeFileSync(promptPath, reviewPrompt, 'utf-8');
        // Clear stale files so a prior iteration's artifacts cannot be
        // misattributed to this invocation if the agent omits to rewrite them.
        // result.json is cleared too: after a fix step the worktree contains the
        // fixer's result.json (fix-review schema); a reviewer that exits 0 but
        // forgets to write its own result.json would otherwise satisfy the
        // adapter's artifact-exists check with the stale file, and
        // readReviewVerdict would parse a fix-review schema as whole-pr-review.
        rmSync(join(ctx.cwd, 'code-review.md'), { force: true });
        rmSync(join(ctx.cwd, 'result.json'), { force: true });
        const startCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: ctx.cwd,
        })
          .toString()
          .trim();
        const result = await router.invoke({
          profile: AgentProfileName(reviewProfileName),
          promptPath,
          expectedArtifacts: ['result.json', 'code-review.md'],
          cwd: ctx.cwd,
          runId: String(ctx.runId),
          repoId: ctx.repoId,
          phaseId: 'whole-pr-review',
          startCommitSha,
        });
        const invocationId = newestInvocationId(String(ctx.runId));
        const inv = agentInvocationRepository.findById(AgentInvocationId(invocationId));
        const store: ArtifactStore = {
          async read(_runId: string, relativePath: string): Promise<string> {
            return await readFile(join(ctx.cwd, relativePath), 'utf-8');
          },
          write: async () => {
            throw new Error('not implemented');
          },
          list: async () => [],
        };
        // External runtimes (antigravity etc.) do not populate resultJsonPath
        // on the invocation row even when result.json was written. Fall back
        // to the expected artifact name so readReviewVerdict can find it.
        const patchedInv = inv?.resultJsonPath
          ? inv
          : inv
            ? { ...inv, resultJsonPath: 'result.json' }
            : inv;
        const verdict = patchedInv
          ? await readReviewVerdict(
              patchedInv,
              { artifacts: store, agent: router },
              {
                blockOnSeverity: config.phases.reviewFix.blockOnSeverity,
              },
            )
          : { ok: false as const, detail: 'no invocation row' };
        // Preserve review artifacts to a stable per-iteration path so they
        // survive subsequent iterations that overwrite result.json and
        // code-review.md in the worktree.
        const reviewArtifactDir = join(
          runsDir,
          runDir,
          'review-fix',
          ctx.loopId,
          'review',
          String(ctx.phaseId),
          `iter-${ctx.iterationIndex}`,
        );
        mkdirSync(reviewArtifactDir, { recursive: true });
        try {
          copyFileSync(join(ctx.cwd, 'code-review.md'), join(reviewArtifactDir, 'code-review.md'));
        } catch {
          /* best-effort */
        }
        try {
          copyFileSync(join(ctx.cwd, 'result.json'), join(reviewArtifactDir, 'result.json'));
        } catch {
          /* best-effort */
        }
        return {
          invocationId,
          agentOutcome: result.outcome,
          ...(verdict.ok
            ? {
                verdict: verdict.verdict,
                ...(verdict.overridden !== undefined ? { overridden: verdict.overridden } : {}),
                ...(verdict.offendingFindings !== undefined
                  ? { offendingFindings: verdict.offendingFindings }
                  : {}),
              }
            : {}),
        };
      };

      const runFix = async (
        ctx: StepContext,
        opts: {
          useFallback: boolean;
          previousInvocationId?: string;
          architectPlan?: {
            version: number;
            tasks: Array<{
              task_id: string;
              approach: string;
              conflicts_resolved: string[];
              constraints: string[];
              depends_on: string[];
            }>;
          };
        },
      ): Promise<FixStepResult> => {
        const runDir = runRepository.findByUuid(String(ctx.runId))?.displayId ?? String(ctx.runId);
        const profile =
          opts.useFallback && fixFallbackProfileName ? fixFallbackProfileName : fixProfileName;
        const promptDir = join(baseTmpDir, 'review-fix-prompts');
        mkdirSync(promptDir, { recursive: true });
        const promptPath = join(promptDir, `fix-${String(ctx.runId)}-${ctx.iterationIndex}.md`);
        const fixPrompt = [
          'You are fixing code review findings.',
          '',
          '## CONTEXT',
          `Working directory: ${ctx.cwd}`,
          `Repository: ${ctx.repoId}`,
          'Review findings: ./code-review.md',
          '',
          '## TASK',
          'Read the code review findings.',
          'Fix ALL legitimate review findings across all severities.',
          '',
          'Rules:',
          '- Fix only what the review asks for. Do not expand scope.',
          '- Do not rewrite working code for style preference.',
          '- If a finding is invalid, skip it.',
          '',
          'After fixing, write a result.json file with exactly one of:',
          '{ "result": "done_with_fixes" }',
          '{ "result": "done_no_fixes_needed" }',
          '{ "result": "cannot_fix" }',
          '',
          ...(opts.architectPlan
            ? [
                '',
                '## CROSS-TASK FIX PLAN',
                `The following architect analysis provides cross-task context for this fix:`,
                ...opts.architectPlan.tasks.map((t) =>
                  [
                    `### Task: ${t.task_id}`,
                    `**Approach:** ${t.approach}`,
                    ...(t.conflicts_resolved.length > 0
                      ? [`**Conflicts resolved:** ${t.conflicts_resolved.join(', ')}`]
                      : []),
                    ...(t.constraints.length > 0
                      ? [`**Constraints:** ${t.constraints.join(', ')}`]
                      : []),
                    ...(t.depends_on.length > 0
                      ? [`**Depends on:** ${t.depends_on.join(', ')}`]
                      : []),
                  ].join('\n'),
                ),
              ]
            : []),
          '',
          '## CRITICAL RULES',
          '- Do NOT ask questions.',
          '- Do NOT switch branches. All work must stay on the current branch.',
          '- After fixing, run: git add -A && git commit -m "fix: review findings"',
          '- Write result.json last.',
          '',
          ...(opts.useFallback
            ? [
                '',
                '## NOTE',
                'The previous fix attempt failed. Review the current state carefully',
                'and consider a different approach to address the findings.',
              ]
            : []),
        ].join('\n');
        writeFileSync(promptPath, fixPrompt, 'utf-8');
        // Clear stale result.json from a prior step so the adapter's
        // artifact-exists check cannot be satisfied by a prior step's file.
        rmSync(join(ctx.cwd, 'result.json'), { force: true });
        const startCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: ctx.cwd,
        })
          .toString()
          .trim();
        const result = await router.invoke({
          profile: AgentProfileName(profile),
          promptPath,
          expectedArtifacts: ['result.json'],
          cwd: ctx.cwd,
          runId: String(ctx.runId),
          repoId: ctx.repoId,
          phaseId: 'fix-review',
          startCommitSha,
          ...(opts.useFallback && opts.previousInvocationId
            ? {
                fallbackOfInvocationId: AgentInvocationId(opts.previousInvocationId),
                fallbackReason: 'use_case_escalation',
              }
            : {}),
        });
        const invocationId = newestInvocationId(String(ctx.runId));
        const inv = agentInvocationRepository.findById(AgentInvocationId(invocationId));
        const store: ArtifactStore = {
          async read(_runId: string, relativePath: string): Promise<string> {
            return await readFile(join(ctx.cwd, relativePath), 'utf-8');
          },
          write: async () => {
            throw new Error('not implemented');
          },
          list: async () => [],
        };
        const patchedFixInv = inv?.resultJsonPath
          ? inv
          : inv
            ? { ...inv, resultJsonPath: 'result.json' }
            : inv;
        const verdict = patchedFixInv
          ? await readFixVerdict(patchedFixInv, { artifacts: store, agent: router })
          : { ok: false as const, detail: 'no invocation row' };
        // Reject done_with_fixes when git commit did not advance the HEAD SHA.
        // The fixer may have written result.json but failed to commit (e.g.
        // missing git identity). Without this check the loop would accept the
        // fix, run revalidation against dirty uncommitted files, and subsequent
        // review iterations would diff origin/<base>...HEAD (the pre-fix commit),
        // silently discarding the fix's changes.
        const shaAdvanced =
          result.endCommitSha !== undefined && result.endCommitSha !== startCommitSha;
        const effectiveVerdict =
          verdict.ok && verdict.verdict === 'done_with_fixes' && !shaAdvanced
            ? undefined
            : verdict.ok
              ? verdict.verdict
              : undefined;
        // Preserve fix artifacts to a stable per-iteration path before
        // subsequent iterations overwrite result.json in the worktree.
        const fixArtifactDir = join(
          runsDir,
          runDir,
          'review-fix',
          ctx.loopId,
          'fix',
          String(ctx.phaseId),
          `iter-${ctx.iterationIndex}`,
        );
        mkdirSync(fixArtifactDir, { recursive: true });
        try {
          copyFileSync(join(ctx.cwd, 'result.json'), join(fixArtifactDir, 'result.json'));
        } catch {
          /* best-effort */
        }
        // If HEAD advanced but the fix did not produce a valid done_with_fixes
        // result, revert the commit so the worktree is clean for the next review
        // iteration. Without this guard a failed fix invocation that nonetheless
        // committed changes would leave unvalidated modifications in the worktree;
        // the loop records it as unresolved but the next review would diff
        // against origin/<base>...HEAD (which now includes the spurious commit),
        // and if that review returns 'pass' the loop resolves without running
        // revalidation on the unvalidated changes.
        if (shaAdvanced && effectiveVerdict !== 'done_with_fixes') {
          execFileSync('git', ['reset', '--hard', startCommitSha], {
            cwd: ctx.cwd,
          });
        }
        // Carry the pre-fix SHA so the loop can roll back if revalidation
        // subsequently fails. Only set when the fix actually advanced HEAD
        // and produced a valid done_with_fixes verdict (the compose helper
        // already reverts all other cases above).
        const headBeforeFix =
          shaAdvanced && effectiveVerdict === 'done_with_fixes' ? startCommitSha : undefined;
        return {
          invocationId,
          agentOutcome: result.outcome,
          ...(effectiveVerdict !== undefined ? { verdict: effectiveVerdict } : {}),
          ...(headBeforeFix !== undefined ? { headBeforeFix } : {}),
        };
      };

      const runRevalidation = async (ctx: StepContext): Promise<RevalidationResult> => {
        const runDir = runRepository.findByUuid(String(ctx.runId))?.displayId ?? String(ctx.runId);
        const revalidateLogDir = join(
          runsDir,
          runDir,
          'revalidate',
          ctx.loopId,
          String(ctx.phaseId),
          `iter-${ctx.iterationIndex}`,
        );
        const vr = await runValidation.execute({
          runId: RunId(String(ctx.runId)),
          phaseId: PhaseName('validate'),
          cwd: ctx.cwd,
          logDir: revalidateLogDir,
          commands: config.validation.commands,
          timeoutSeconds: config.validation.timeout,
        });
        const failedCommand = vr.validationRun.commands.find((c) => c.outcome !== 'passed');
        return {
          validationRunId: vr.validationRun.id,
          passed: vr.passed,
          ...(failedCommand?.kind ? { category: failedCommand.kind } : {}),
        };
      };

      // Wrap the in-memory bus so loop events survive process restarts.
      // Without this wrapper loop.iteration.*, loop.exhausted, and
      // phase.fallback.escalated events vanish when no live subscriber exists.
      const persistingEventBusForLoop: EventBusPort = {
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
            // Best-effort: event persistence must not crash the loop
          }
        },
      };

      const resolveStartCommitSha = (cwd: string, runId: string): string => {
        try {
          return execFileSync('git', ['rev-parse', 'HEAD'], { cwd }).toString().trim();
        } catch (err) {
          persistingEventBusForLoop.publish(runId, {
            runId,
            level: 'warn',
            type: 'git.rev_parse_failed',
            message: `git rev-parse HEAD failed: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: new Date().toISOString(),
            metadata: { cwd },
          });
          return '';
        }
      };

      const rollbackFix = async (ctx: StepContext, targetSha: string): Promise<void> => {
        execFileSync('git', ['reset', '--hard', targetSha], { cwd: ctx.cwd });
      };

      reviewFixLoop = new ReviewFixLoop({
        runReview,
        runFix,
        runRevalidation,
        rollbackFix,
        loops: loopRepository,
        events: persistingEventBusForLoop,
        now: () => new Date(),
        idFactory: () => randomUUID(),
      });

      const implementProfileName: string =
        config.agent.phaseProfiles['implement']?.profile ?? 'opencode-frontier';
      const specReviewProfileName: string =
        config.agent.phaseProfiles['spec-review']?.profile ?? 'opencode-frontier';
      const qualityReviewProfileName: string =
        config.agent.phaseProfiles['quality-review']?.profile ?? 'pi-qwen-local';
      const implFixProfileName: string =
        config.agent.phaseProfiles['fix-review']?.profile ?? 'opencode-frontier';
      const implFixFallbackProfileName: string | undefined =
        config.agent.phaseProfiles['fix-review']?.fallbackProfile;

      const makeArtifactStore = (cwd: string): ArtifactStore => ({
        async read(_runId: string, relativePath: string): Promise<string> {
          return await readFile(join(cwd, relativePath), 'utf-8');
        },
        write: async () => {
          throw new Error('not implemented');
        },
        list: async () => [],
      });

      const runImplement = async (ctx: StepLoopContext) => {
        const runDir = runRepository.findByUuid(String(ctx.runId))?.displayId ?? String(ctx.runId);
        const promptDir = join(baseTmpDir, 'implement-step-prompts');
        mkdirSync(promptDir, { recursive: true });
        const promptPath = join(promptDir, `implement-${String(ctx.runId)}-${ctx.stepIndex}.md`);
        const implementPrompt = [
          '# TASK',
          `Step ${ctx.stepIndex}: ${ctx.stepTitle}`,
          '',
          '## CONTEXT',
          `Working directory: ${ctx.cwd}`,
          `Repository: ${ctx.repoId}`,
          '',
          'Read plan.md and implement this step. Write a summary to implementation-log.md.',
        ].join('\n');
        writeFileSync(promptPath, implementPrompt, 'utf-8');
        rmSync(join(ctx.cwd, 'result.json'), { force: true });
        const startCommitSha = resolveStartCommitSha(ctx.cwd, String(ctx.runId));
        let result;
        try {
          result = await router.invoke({
            profile: AgentProfileName(implementProfileName),
            promptPath,
            expectedArtifacts: ['result.json'],
            cwd: ctx.cwd,
            runId: String(ctx.runId),
            repoId: ctx.repoId,
            phaseId: 'implement',
            startCommitSha,
          });
        } catch (err) {
          persistingEventBusForLoop.publish(String(ctx.runId), {
            runId: String(ctx.runId),
            level: 'error',
            type: 'agent.invoke_failed',
            message: `Agent invocation failed: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: new Date().toISOString(),
            metadata: { phaseId: 'implement', stepIndex: ctx.stepIndex },
          });
          return { invocationId: '', agentOutcome: 'failed' as const };
        }
        const invocationId = newestInvocationId(String(ctx.runId));
        const inv = agentInvocationRepository.findById(AgentInvocationId(invocationId));
        // Preserve to iteration-stable path
        const artifactDir = join(runsDir, runDir, 'implement-step', `step-${ctx.stepIndex}`);
        mkdirSync(artifactDir, { recursive: true });
        if (inv?.resultJsonPath) {
          try {
            copyFileSync(
              join(ctx.cwd, inv.resultJsonPath),
              join(artifactDir, `result-iter-0.json`),
            );
          } catch (err) {
            persistingEventBusForLoop.publish(String(ctx.runId), {
              runId: String(ctx.runId),
              level: 'warn',
              type: 'artifact.copy_failed',
              message: `Failed to copy artifact: ${err instanceof Error ? err.message : String(err)}`,
              timestamp: new Date().toISOString(),
              metadata: {
                source: join(ctx.cwd, inv.resultJsonPath),
                destination: join(artifactDir, 'result-iter-0.json'),
              },
            });
          }
        }
        return {
          invocationId,
          agentOutcome: result.outcome,
        };
      };

      // Per-step typecheck gate (#403): run the full-repo typecheck in the
      // worktree. The result both gates the step (a red typecheck fails it
      // before review) and is injected into the reviewer prompts as ground
      // truth (a reviewer demanding a non-compiling change is overruled).
      const runTypecheck = async (ctx: StepLoopContext): Promise<TypecheckResult> => {
        try {
          execFileSync('pnpm', ['-r', 'typecheck'], { cwd: ctx.cwd, stdio: 'pipe' });
          return { outcome: 'pass', output: '' };
        } catch (err) {
          const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
          const output = `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`.trim();
          return { outcome: 'fail', output };
        }
      };

      // Render the typecheck signal for injection into a reviewer prompt.
      const typecheckBlock = (tc: TypecheckResult): string[] =>
        tc.outcome === 'pass'
          ? ['## TYPECHECK SIGNAL', '`pnpm -r typecheck` is GREEN for this step.', '']
          : [
              '## TYPECHECK SIGNAL',
              '`pnpm -r typecheck` is RED. Do NOT request changes that would not compile;',
              'the build is ground truth. Typecheck output:',
              '```',
              tc.output.slice(0, 2000),
              '```',
              '',
            ];

      const runSpecReview = async (ctx: StepLoopContext, tcResult: TypecheckResult) => {
        const promptDir = join(baseTmpDir, 'implement-step-prompts');
        mkdirSync(promptDir, { recursive: true });
        const promptPath = join(
          promptDir,
          `spec-review-${String(ctx.runId)}-${ctx.stepIndex}-${ctx.iterationIndex}.md`,
        );
        const reviewPrompt = [
          '# TASK',
          `Review implementation of step ${ctx.stepIndex}: ${ctx.stepTitle}`,
          '',
          'Check that the implementation matches plan.md task requirements exactly.',
          '',
          ...typecheckBlock(tcResult),
          '## OUTPUT',
          'Write result.json: { "result": "pass" | "fail" }',
        ].join('\n');
        writeFileSync(promptPath, reviewPrompt, 'utf-8');
        rmSync(join(ctx.cwd, 'result.json'), { force: true });
        const startCommitSha = resolveStartCommitSha(ctx.cwd, String(ctx.runId));
        let result;
        try {
          result = await router.invoke({
            profile: AgentProfileName(specReviewProfileName),
            promptPath,
            expectedArtifacts: ['result.json'],
            cwd: ctx.cwd,
            runId: String(ctx.runId),
            repoId: ctx.repoId,
            phaseId: 'spec-review',
            startCommitSha,
          });
        } catch (err) {
          persistingEventBusForLoop.publish(String(ctx.runId), {
            runId: String(ctx.runId),
            level: 'error',
            type: 'agent.invoke_failed',
            message: `Agent invocation failed: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: new Date().toISOString(),
            metadata: { phaseId: 'spec-review', stepIndex: ctx.stepIndex },
          });
          return { invocationId: '', agentOutcome: 'failed' as const };
        }
        const invocationId = newestInvocationId(String(ctx.runId));
        const inv = agentInvocationRepository.findById(AgentInvocationId(invocationId));
        if (!inv) return { invocationId, agentOutcome: result.outcome };
        const patched = inv.resultJsonPath ? inv : { ...inv, resultJsonPath: 'result.json' };
        const verdict = await readReviewVerdict(
          patched,
          { artifacts: makeArtifactStore(ctx.cwd), agent: router },
          { blockOnSeverity: config.phases.reviewFix.blockOnSeverity },
        );
        if (!verdict.ok) return { invocationId, agentOutcome: 'contract_violation' as const };
        return {
          invocationId,
          agentOutcome: 'success' as const,
          verdict: verdict.verdict,
        };
      };

      const runQualityReview = async (ctx: StepLoopContext, tcResult: TypecheckResult) => {
        const promptDir = join(baseTmpDir, 'implement-step-prompts');
        mkdirSync(promptDir, { recursive: true });
        const promptPath = join(
          promptDir,
          `quality-review-${String(ctx.runId)}-${ctx.stepIndex}-${ctx.iterationIndex}.md`,
        );
        const reviewPrompt = [
          '# TASK',
          `Review implementation quality for step ${ctx.stepIndex}: ${ctx.stepTitle}`,
          '',
          'Check for code quality: maintainability, performance, security, test coverage.',
          '',
          ...typecheckBlock(tcResult),
          '## OUTPUT',
          'Write result.json: { "result": "pass" | "fail" }',
        ].join('\n');
        writeFileSync(promptPath, reviewPrompt, 'utf-8');
        rmSync(join(ctx.cwd, 'result.json'), { force: true });
        const startCommitSha = resolveStartCommitSha(ctx.cwd, String(ctx.runId));
        let result;
        try {
          result = await router.invoke({
            profile: AgentProfileName(qualityReviewProfileName),
            promptPath,
            expectedArtifacts: ['result.json'],
            cwd: ctx.cwd,
            runId: String(ctx.runId),
            repoId: ctx.repoId,
            phaseId: 'quality-review',
            startCommitSha,
          });
        } catch (err) {
          persistingEventBusForLoop.publish(String(ctx.runId), {
            runId: String(ctx.runId),
            level: 'error',
            type: 'agent.invoke_failed',
            message: `Agent invocation failed: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: new Date().toISOString(),
            metadata: { phaseId: 'quality-review', stepIndex: ctx.stepIndex },
          });
          return { invocationId: '', agentOutcome: 'failed' as const };
        }
        const invocationId = newestInvocationId(String(ctx.runId));
        const inv = agentInvocationRepository.findById(AgentInvocationId(invocationId));
        if (!inv) return { invocationId, agentOutcome: result.outcome };
        const patched = inv.resultJsonPath ? inv : { ...inv, resultJsonPath: 'result.json' };
        const verdict = await readReviewVerdict(
          patched,
          { artifacts: makeArtifactStore(ctx.cwd), agent: router },
          { blockOnSeverity: config.phases.reviewFix.blockOnSeverity },
        );
        if (!verdict.ok) return { invocationId, agentOutcome: 'contract_violation' as const };
        return {
          invocationId,
          agentOutcome: 'success' as const,
          verdict: verdict.verdict,
        };
      };

      const implRunFix = async (ctx: StepLoopContext, opts: FixStepOptions) => {
        const promptDir = join(baseTmpDir, 'implement-step-prompts');
        mkdirSync(promptDir, { recursive: true });
        const promptPath = join(
          promptDir,
          `fix-${String(ctx.runId)}-${ctx.stepIndex}-${ctx.iterationIndex}.md`,
        );
        const profile =
          opts.useFallback && implFixFallbackProfileName
            ? implFixFallbackProfileName
            : implFixProfileName;
        const fixPrompt = [
          '# TASK',
          `Fix implementation issues for step ${ctx.stepIndex}: ${ctx.stepTitle}`,
          '',
          '## CONTEXT',
          'Read any review findings in the working directory and apply the suggested fixes.',
          '',
          '## OUTPUT',
          'Write result.json: { "result": "done_with_fixes" | "done_no_fixes_needed" | "cannot_fix" }',
        ].join('\n');
        writeFileSync(promptPath, fixPrompt, 'utf-8');
        rmSync(join(ctx.cwd, 'result.json'), { force: true });
        const startCommitSha = resolveStartCommitSha(ctx.cwd, String(ctx.runId));
        let invokeResult;
        try {
          invokeResult = await router.invoke({
            profile: AgentProfileName(profile),
            promptPath,
            expectedArtifacts: ['result.json'],
            cwd: ctx.cwd,
            runId: String(ctx.runId),
            repoId: ctx.repoId,
            phaseId: 'fix-review',
            startCommitSha,
            ...(opts.previousInvocationId
              ? {
                  fallbackOfInvocationId: AgentInvocationId(opts.previousInvocationId),
                  fallbackReason: 'two_consecutive_fix_failures',
                }
              : {}),
          });
        } catch (err) {
          persistingEventBusForLoop.publish(String(ctx.runId), {
            runId: String(ctx.runId),
            level: 'error',
            type: 'agent.invoke_failed',
            message: `Agent invocation failed: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: new Date().toISOString(),
            metadata: { phaseId: 'fix-review', stepIndex: ctx.stepIndex },
          });
          return { invocationId: '', agentOutcome: 'failed' as const };
        }
        const invocationId = newestInvocationId(String(ctx.runId));
        const inv = agentInvocationRepository.findById(AgentInvocationId(invocationId));
        if (!inv) return { invocationId, agentOutcome: invokeResult.outcome };
        const patched = inv.resultJsonPath ? inv : { ...inv, resultJsonPath: 'result.json' };
        const fixVerdict = await readFixVerdict(patched, {
          artifacts: makeArtifactStore(ctx.cwd),
          agent: router,
        });
        return {
          invocationId,
          agentOutcome: fixVerdict.ok ? ('success' as const) : ('contract_violation' as const),
          ...(fixVerdict.ok ? { verdict: fixVerdict.verdict } : {}),
        };
      };

      implementStepLoop = new ImplementStepLoop({
        runImplement,
        runTypecheck,
        runSpecReview,
        runQualityReview,
        runFix: implRunFix,
        loops: loopRepository,
        events: persistingEventBusForLoop,
        fixProfile: AgentProfileName(implFixProfileName),
        ...(implFixFallbackProfileName
          ? { fixFallbackProfile: AgentProfileName(implFixFallbackProfileName) }
          : {}),
        now: () => new Date(),
        idFactory: () => randomUUID(),
      });

      runStep = async (sctx: {
        stepIndex: number;
        stepTitle: string;
        cwd: string;
        ctx: import('@ai-sdlc/application').PhaseHandlerContext;
      }): Promise<{ outcome: 'success' | 'failed' }> => {
        if (!implementStepLoop) throw new Error('implementStepLoop not initialized');
        const result = await implementStepLoop.execute({
          runId: RunId(sctx.ctx.runUuid),
          phaseId: PhaseName('implement'),
          repoId: sctx.ctx.repoFullName,
          cwd: sctx.cwd,
          stepIndex: sctx.stepIndex,
          stepTitle: sctx.stepTitle,
          maxIterations: config.phases.implement.maxIterations,
        });
        return { outcome: result.outcome };
      };

      // In-memory artifact store for the context factory — handlers receive
      // a real store via buildPhaseHandlerContext in the agent phase flow.
      // Returning [] from list means resume validation will fail if real
      // handlers are invoked (expected — handlers are not yet wired).
      const stubArtifactStore: ArtifactStore = {
        write: async () => {
          throw new Error('not implemented');
        },
        read: async () => {
          throw new Error('not implemented');
        },
        list: async () => {
          throw new Error('not implemented');
        },
      };
      runExecutor = new RunExecutor({
        runRepository,
        failureRepository,
        phaseRepository,
        events: eventBus,
        registry: phaseRegistry,
        contextFactory: () =>
          ({
            runId: '',
            runUuid: 'stub',
            repoFullName: '',
            issueNumber: 0,
            cwd: '',
            artifacts: stubArtifactStore,
            github: {
              getIssue: () => {
                throw new Error(
                  'PhaseHandlerContext.github is not available from contextFactory — wire through buildPhaseHandlerContext in agent phase flow',
                );
              },
            } as never,
            git: {
              resetHard: () => {
                throw new Error(
                  'PhaseHandlerContext.git is not available from contextFactory — wire through buildPhaseHandlerContext in agent phase flow',
                );
              },
            } as never,
            agent: {
              run: () => {
                throw new Error(
                  'PhaseHandlerContext.agent is not available from contextFactory — wire through buildPhaseHandlerContext in agent phase flow',
                );
              },
            } as never,
            events: eventBus,
            now: () => new Date(),
          }) as PhaseHandlerContext,
      });
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
        // -x also removes worktree-ignored orchestrator artifacts (result.json,
        // *.md, *.result, logs) that the script seeds into .git/info/exclude, so
        // a cancelled/reset run can't leak stale results into the next run on the
        // reused worktree. node_modules is excluded to avoid an expensive reinstall.
        execFileSync('git', ['clean', '-fdx', '-e', 'node_modules'], { cwd });
      },
    };
    const processor = new ProcessPrReviewComments({
      github: ghAdapter,
      git: gitAdapter,
      agent: agentRuntime,
      prReviewRepo: prReviewRepository,
      renderTaskPrompt: async ({ cwd, comment, diff, branch }) => {
        const promptDir = join(baseTmpDir, 'pr-review-prompt');
        mkdirSync(promptDir, { recursive: true });
        const promptPath = join(promptDir, `prompt-${comment.commentId}.md`);
        const content = [
          '# PR Review Comment Task',
          '',
          'Address the following PR review comment:',
          '',
          `- [commentId: ${comment.commentId}] ${comment.path}:${comment.line} — ${comment.body}`,
          '',
          '## Current Diff',
          '',
          diff,
          '',
          '## Instructions',
          '',
          'Make a judgement call: is this comment technically valid?',
          '',
          'If a code change is required:',
          '1. Edit the relevant source files',
          '2. Stage and commit: `git add -A && git commit -m "fix: address PR review feedback"`',
          `3. Push: \`git push origin '${branch.replace(/'/g, "'\\''")}'\``,
          '',
          'If the comment is invalid, include your reasoning in replyBody.',
          '',
          'IMPORTANT: Do NOT post replies yourself. The orchestrator handles posting.',
          '',
          '## Required Output',
          '',
          `Write a result.json file at: ${join(cwd, 'result.json')}`,
          '',
          '```json',
          '{',
          '  "commentId": <number>,',
          '  "action": "fixed" | "no_fix" | "blocked",',
          '  "replyBody": "<non-empty string>",',
          '  "blockedReason": "<string — only when action is blocked>"',
          '}',
          '```',
        ].join('\n');
        writeFileSync(promptPath, content, 'utf-8');
        return promptPath;
      },
      extractTaskResult: async (input) => {
        try {
          const absPath = input.resultJsonPath
            ? join(input.cwd, input.resultJsonPath)
            : join(input.cwd, 'result.json');
          const raw = readFileSync(absPath, 'utf-8');
          const parsed = JSON.parse(raw);
          const result = pollTaskResultSchema.safeParse(parsed);
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
      onAllResolved: async (input) => {
        try {
          let record = runRepository.findByUuid(String(input.runId));
          if (!record) return 'stay_ready';
          // Transition running → waiting so existing runs (non-synthetic poll
          // path) can enter the reactivation check. The synthetic path does
          // this in runStatusForTerminalState before the poller starts.
          if (record.status === 'running') {
            const readyAt = new Date();
            runRepository.update(record.uuid, { status: 'waiting', completedAt: readyAt });
            record = { ...record, status: 'waiting', completedAt: readyAt };
          }
          if (record.status !== 'waiting') return 'stay_ready';
          const comments = await ghAdapter.listReviewComments(input.repoFullName, input.prNumber);
          const reviewerComments = comments;
          const newestCommentAt = reviewerComments.reduce(
            (max, c) => (c.createdAt.getTime() > max.getTime() ? c.createdAt : max),
            record.completedAt ?? new Date(0),
          );
          const lastAttempt = prReviewRepository.latestPollAttempt(input.runId);
          const lastSeenActivityAt = lastAttempt?.startedAt ?? record.startedAt;
          const decision = decideReactivation({
            readyAt: record.completedAt ?? record.startedAt,
            now: new Date(),
            readyMaxDays: opts.readyMaxDays,
            lastSeenActivityAt,
            newestCommentAt,
          });
          const run = record;
          applyReactivation(run, decision, {
            runRepository,
            eventBus: persistingEventBus,
            now: () => new Date(),
          });
          return decision.action;
        } catch (err) {
          console.error(
            { err, runId: input.runId },
            'onAllResolved callback failed, staying ready',
          );
          return 'stay_ready';
        }
      },
      revertRunStatus: async (runId) => {
        runRepository.update(String(runId), { status: 'waiting' });
      },
      maxReactivations: 100,
    });
  }

  return {
    runRepository,
    phaseRepository,
    phaseRegistry,
    ...(runExecutor !== undefined ? { runExecutor } : {}),
    eventRepository,
    artifactRepository,
    failureRepository,
    agentInvocationRepository,
    validationRunRepository,
    prReviewRepository,
    loopRepository,
    runValidation,
    startIssueRun,
    cancelRun,
    runsDir,
    baseTmpDir,
    defaultBranch: resolvedDefaultBranch,
    eventBus,
    ...(agentRuntime ? { agentRuntime } : {}),
    resolveProfileForPhase: resolveProfileForPhaseBound ?? defaultResolve,
    buildPrReviewPoller,
    ...(reviewFixLoop !== undefined ? { reviewFixLoop } : {}),
    ...(implementStepLoop !== undefined ? { implementStepLoop } : {}),
    ...(runStep !== undefined ? { runStep } : {}),
    buildPhaseHandlerContext: (base, opts) => {
      const idFactory = () => randomUUID();
      return {
        ...base,
        // Always-provided optional fields via compose root wiring:
        ...(resolveProfileForPhaseBound ? { resolveProfile: resolveProfileForPhaseBound } : {}),
        idFactory,
        // Caller-supplied optional fields take precedence:
        ...opts,
      };
    },
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

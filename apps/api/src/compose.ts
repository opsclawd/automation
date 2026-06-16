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
  readReviewVerdict,
  readFixVerdict,
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
} from '@ai-sdlc/application';
import { ConfigError, loadConfig, PHASE_FALLBACKS, type AgentConfig } from '@ai-sdlc/shared';
import { AgentProfileName, AgentInvocationId, PhaseName, RunId } from '@ai-sdlc/domain';
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
  eventBus: EventBusPort;
  /** @deprecated Use `resolveProfileForPhase()` instead */
  agentRuntime?: AgentRuntimeRouter;
  resolveProfileForPhase: (phaseName: string) => AgentProfileName;
  reviewFixLoop?: ReviewFixLoop;
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
  const agentUsageRepository = new AgentUsageRepository(db);
  const loopRepository = new LoopRepository(db);
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
  let reviewFixLoop: ReviewFixLoop | undefined;
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
          ? await readReviewVerdict(patchedInv, { artifacts: store, agent: router })
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
          ...(verdict.ok ? { verdict: verdict.verdict } : {}),
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
    eventBus,
    ...(agentRuntime ? { agentRuntime } : {}),
    resolveProfileForPhase: resolveProfileForPhaseBound ?? defaultResolve,
    buildPrReviewPoller,
    ...(reviewFixLoop !== undefined ? { reviewFixLoop } : {}),
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

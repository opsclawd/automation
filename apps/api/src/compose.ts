import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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
} from '@ai-sdlc/infrastructure';
import {
  StartIssueRun,
  CancelRun,
  SweepOrphanedRuns,
  checkPid,
  RunValidation,
  PrReviewPoller,
  type StartIssueRunDeps,
  type ClassifyExitFn,
  type EventTailerFactory,
  type EventBusPort,
  type RunRepositoryPort,
  type TmpDirectoryFactory,
} from '@ai-sdlc/application';
import { ConfigError, loadConfig, type AgentConfig } from '@ai-sdlc/shared';
import { AgentProfileName, RunId } from '@ai-sdlc/domain';
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
  const entry = agent.phaseProfiles[phaseName];
  if (!entry) {
    throw new ConfigError(`unknown phase '${phaseName}'`);
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
  }): PrReviewPoller {
    return new PrReviewPoller({
      prReviewRepo: prReviewRepository,
      processOnePass: async () => {
        throw new Error('processOnePass not wired — wire ProcessPrReviewComments in M6-05');
      },
      eventBus,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => new Date(),
      maxPolls: opts.maxPolls,
      pollIntervalMs: opts.pollIntervalMs,
      readyMaxDays: opts.readyMaxDays,
      phaseStartedAt: opts.phaseStartedAt,
      recordTerminalState: async (attempt, state, _pollsRun) => {
        if (attempt) {
          prReviewRepository.updatePollAttempt({
            ...attempt,
            status: 'completed',
            terminalState: state,
            completedAt: new Date(),
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

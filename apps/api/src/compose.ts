import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
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
  RunDirectory,
  runBashScript,
  classifyExit,
  InMemoryEventBus,
  EventTailer,
} from '@ai-sdlc/infrastructure';
import {
  StartIssueRun,
  CancelRun,
  SweepOrphanedRuns,
  checkPid,
  type StartIssueRunDeps,
  type ClassifyExitFn,
  type EventTailerFactory,
  type EventBusPort,
  type RunRepositoryPort,
  type TmpDirectoryFactory,
} from '@ai-sdlc/application';
import { ConfigError, loadConfig } from '@ai-sdlc/shared';
import { FakeAgentPort } from '@ai-sdlc/application/test-doubles';
import { AgentRuntimeRegistry } from './agent-runtime-registry.js';

const classifyExitAdapter: ClassifyExitFn = (input) => {
  return classifyExit(input);
};

export interface Container {
  runRepository: RunRepository;
  phaseRepository: PhaseRepository;
  eventRepository: EventRepository;
  artifactRepository: ArtifactRepository;
  failureRepository: FailureRepository;
  agentInvocationRepository: AgentInvocationRepository;
  startIssueRun: StartIssueRun;
  cancelRun: CancelRun;
  runsDir: string;
  baseTmpDir: string;
  eventBus: EventBusPort;
  agentRuntime?: AgentRuntimeRegistry;
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

  const phaseRepository = new PhaseRepository(db);
  const eventRepository = new EventRepository(db);
  const artifactRepository = new ArtifactRepository(db);
  const failureRepository = new FailureRepository(db);
  const agentInvocationRepository = new AgentInvocationRepository(db);
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
    classifyExit: classifyExitAdapter,
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

  let agentRuntime: AgentRuntimeRegistry | undefined;
  try {
    const config = loadConfig(opts.repoRoot);
    if (config.agent) {
      agentRuntime = new AgentRuntimeRegistry({
        agent: config.agent,
        adapters: {
          // TODO(M4): Replace with real adapters (opencode, pi).
          opencode: new FakeAgentPort({}),
          pi: new FakeAgentPort({}),
        },
      });
    }
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // Only suppress ENOENT (config file missing) — invalid JSON, schema
    // violations, and read errors must surface to the operator.
    if ((err.cause as { code?: string })?.code !== 'ENOENT') throw err;
    // agentRuntime stays undefined. Existing compose callers (tests, CLI
    // without .ai-orchestrator.json) continue to work.
  }

  return {
    runRepository,
    phaseRepository,
    eventRepository,
    artifactRepository,
    failureRepository,
    agentInvocationRepository,
    startIssueRun,
    cancelRun,
    runsDir,
    baseTmpDir,
    eventBus,
    ...(agentRuntime ? { agentRuntime } : {}),
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

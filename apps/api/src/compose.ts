import { join } from 'node:path';
import {
  openDatabase,
  applyMigrations,
  RunRepository,
  PhaseRepository,
  EventRepository,
  ArtifactRepository,
  FailureRepository,
  RunDirectory,
  runBashScript,
  classifyExit,
  type RunRecord,
} from '@ai-sdlc/infrastructure';
import { StartIssueRun, type StartIssueRunDeps, type ClassifyExitFn } from '@ai-sdlc/application';

const classifyExitAdapter: ClassifyExitFn = (input) => {
  return classifyExit(input);
};

export interface Container {
  runRepository: RunRepository;
  phaseRepository: PhaseRepository;
  eventRepository: EventRepository;
  artifactRepository: ArtifactRepository;
  failureRepository: FailureRepository;
  startIssueRun: StartIssueRun;
  serializeRun: (r: RunRecord) => {
    uuid: string;
    displayId: string;
    issueNumber: number;
    status: string;
    currentPhase: string | null;
    completedPhases: string[];
    startedAt: string;
    completedAt: string | null;
    exitCode: number | null;
    durationMs: number | null;
    failureReason: string | null;
  };
  serializeFailure: (f: NonNullable<ReturnType<FailureRepository['findLatestByRun']>>) => {
    kind: string;
    message: string;
    phase?: string;
    exitCode?: number;
    suggestedAction: string;
    artifacts: string[];
  };
  runsDir: string;
}

export interface ComposeOptions {
  repoRoot: string;
  scriptPath: string;
  baseBranch?: string;
  model?: string;
  agentCli?: string;
  tee?: boolean;
}

export function composeRoot(opts: ComposeOptions): Container {
  const runsDir = join(opts.repoRoot, '.ai-runs');
  const db = openDatabase(join(runsDir, 'orchestrator.sqlite'));
  applyMigrations(db);
  const runRepository = new RunRepository(db);
  const phaseRepository = new PhaseRepository(db);
  const eventRepository = new EventRepository(db);
  const artifactRepository = new ArtifactRepository(db);
  const failureRepository = new FailureRepository(db);
  const deps: StartIssueRunDeps = {
    runRepository,
    failureRepository,
    classifyExit: classifyExitAdapter,
    runDirectoryFactory: ({ rootDir, run }) => RunDirectory.create({ rootDir, run }),
    runBashScript,
    runsDir,
    scriptPath: opts.scriptPath,
  };
  if (opts.baseBranch !== undefined) deps.baseBranch = opts.baseBranch;
  if (opts.model !== undefined) deps.model = opts.model;
  if (opts.agentCli !== undefined) deps.agentCli = opts.agentCli;
  if (opts.tee !== undefined) deps.tee = opts.tee;
  const startIssueRun = new StartIssueRun(deps);
  const serializeRun = (r: RunRecord) => ({
    uuid: r.uuid,
    displayId: r.displayId,
    issueNumber: r.issueNumber,
    status: r.status,
    currentPhase: r.currentPhase !== undefined ? r.currentPhase : null,
    completedPhases: r.completedPhases,
    startedAt: r.startedAt.toISOString(),
    completedAt: r.completedAt !== undefined ? r.completedAt.toISOString() : null,
    exitCode: r.exitCode !== undefined ? r.exitCode : null,
    durationMs: r.durationMs !== undefined ? r.durationMs : null,
    failureReason: r.failureReason !== undefined ? r.failureReason : null,
  });

  const serializeFailure = (f: NonNullable<ReturnType<FailureRepository['findLatestByRun']>>) => ({
    kind: f.kind,
    message: f.message,
    ...(f.phase !== undefined ? { phase: f.phase } : {}),
    ...(f.exitCode !== undefined ? { exitCode: f.exitCode } : {}),
    suggestedAction: f.suggestedAction,
    artifacts: f.artifacts,
  });

  return {
    runRepository,
    phaseRepository,
    eventRepository,
    artifactRepository,
    failureRepository,
    startIssueRun,
    serializeRun,
    serializeFailure,
    runsDir,
  };
}

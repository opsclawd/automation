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
} from '@ai-sdlc/infrastructure';
import { StartIssueRun, type StartIssueRunDeps, type ClassifyExitFn } from '@ai-sdlc/application';

const classifyExitAdapter: ClassifyExitFn = (input) => {
  const result = classifyExit(input);
  return { ...result, runUuid: result.runUuid ?? input.runUuid ?? '' };
};

export interface Container {
  runRepository: RunRepository;
  phaseRepository: PhaseRepository;
  eventRepository: EventRepository;
  artifactRepository: ArtifactRepository;
  failureRepository: FailureRepository;
  startIssueRun: StartIssueRun;
  runsDir: string;
}

export interface ComposeOptions {
  repoRoot: string;
  scriptPath: string;
  baseBranch?: string;
  model?: string;
  agentCli?: string;
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
  const startIssueRun = new StartIssueRun(deps);
  return {
    runRepository,
    phaseRepository,
    eventRepository,
    artifactRepository,
    failureRepository,
    startIssueRun,
    runsDir,
  };
}

import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  open as fsOpen,
  stat as fsStat,
  access as fsAccess,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import os from 'node:os';
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
import { dirname, join, basename, resolve, relative, isAbsolute, sep } from 'node:path';
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
  SqliteStepRepository,
  RunDirectory,
  runBashScript,
  classifyExit,
  InMemoryEventBus,
  EventTailer,
  ProcessValidationAdapter,
  GhCliAdapter,
  GitWorktreeAdapter,
  WorkerLeaseRepository,
  JobQueueRepository,
  WorkerRegistryRepository,
  RepositoryMetadataResolver,
  createFilesystemArtifactStore,
  FileTailer,
  createFixDiffInspector,
  listProcesses,
  killProcess,
  createPrReviewContextSource,
  WorktreeLifecycleAdapter,
  WebhookRunNotificationAdapter,
  NoopRunNotificationAdapter,
} from '@ai-sdlc/infrastructure';
import {
  LoadRepositoryForRun,
  StartIssueRun,
  CancelRun,
  ResumeRun,
  RetryFailedPhase,
  SweepOrphanedRuns,
  ReapOrphanedTestWorkers,
  SweepWaitingRuns,
  WaitingRunsSweeper,
  type WaitingRunsSweeperResult,
  OrphanedRunsSweeper,
  type OrphanedRunsSweeperResult,
  checkPid,
  RepositoryRecoveryCoordinator,
  RunValidation,
  ReadIssueHandler,
  PlanDesignHandler,
  ArchitectureReviewHandler,
  ImplementHandler,
  ValidateHandler,
  SpecReviewHandler,
  QualityReviewHandler,
  FixReviewHandler,
  FollowUpReviewHandler,
  CompoundHandler,
  CreatePrHandler,
  WaitMergeHandler,
  PrReviewPoller,
  ProcessPrReviewComments,
  decideReactivation,
  applyReactivation,
  createVerifyCodeChange,
  pollTaskResultSchema,
  pollTaskBatchResultSchema,
  ValidateFixLoop,
  FixValidateHandler,
  CheckMergeReadiness,
  PhaseHandlerRegistry,
  RunExecutor,
  type RunNotificationPort,
  type WorkerLoopDeps,
  type WorkerRegistryPort,
  type ArtifactStore,
  type StartIssueRunDeps,
  type ClassifyExitFn,
  type EventTailerFactory,
  type EventRepositoryFactory,
  type EventBusPort,
  type RunRecord,
  type RunRepositoryPort,
  type TmpDirectoryFactory,
  type RepositoryPort,
  type JobQueuePort,
  type StepRepositoryPort,
  type GitPort,
  type RevalidationResult,
  type PhaseHandlerContext,
  type PhaseHandlerContextFactory,
  type ReadWorktreeFilePort,
  extractTaskBody,
  parseTaskManifest,
  type TaskManifest,
  PHASE_DEFINITIONS,
  RegisterRepository,
  RefreshRepository,
  ListRepositories,
  InspectRepository,
  UpdateRepository,
  EnableRepository,
  DisableRepository,
  RemoveRepository,
  type RepositoryRegistryPort,
  type RepositoryAvailabilityPort,
  type AgentPort,
  type RunAbortPort,
  type ValidationPort,
  type ValidationCommand,
  evaluateRevalidationWithInvertedCommands,
  extractFailedTestFilesFromOutput,
  buildTargetedTestCommand,
  type ValidationRunCommandItem,
  CONTRACT_VIOLATION_CODES,
  type ResolveRefShaFn,
  type ArtifactGuardPort,
  type StepAgentOutcome,
  type ValidateFixStepContext,
  readFixVerdict,
  orchestratorExcludePatterns,
  type ValidationScopeSummary,
} from '@ai-sdlc/application';
import { discoverWorkspacePackages } from './workspace-package-discovery.js';
import { findRepoRoot } from './cli/target-repo-root.js';
import {
  ConfigError,
  DEFAULT_FIRST_REVIEW_GRACE_WINDOW_SECONDS,
  loadConfig,
  loadLayeredConfig,
  type LoadedConfig,
  type OrchestratorConfig,
  PHASE_FALLBACKS,
  resolvePhaseProfileEntry,
  type AgentConfig,
  type ExecutionPolicy,
} from '@ai-sdlc/shared';

interface SchedulerConfig {
  globalConcurrency: number;
  pollIntervalMs: number;
  shutdownGraceMs: number;
}
import {
  AgentProfileName,
  AgentInvocationId,
  PhaseName,
  Repository,
  Run,
  RunId,
  RepositoryId,
  generateJobOwnership,
  type PrReviewComment,
  type ValidationCommandOutcome,
} from '@ai-sdlc/domain';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- forward reference for Task 5 runtime factory
import type { RepositoryRuntimePaths } from './repository-runtime-paths.js';
import {
  DefaultRepositoryRuntimeCatalog,
  type RepositoryRuntimeCatalog,
} from './repository-runtime-catalog.js';

/** Per-Repository outcome of one recovery-sweep pass (#652 Task 6). */
export interface RepositorySweepResult {
  repositoryId: string;
  fullName: string;
  waiting?: WaitingRunsSweeperResult;
  orphaned?: OrphanedRunsSweeperResult;
  error?: string;
}

export interface RepositorySweepCoordinatorResult {
  results: RepositorySweepResult[];
}

/**
 * Runs the waiting/orphan recovery sweeps against every enabled
 * Repository's own operational runtime, aggregating per-Repository
 * outcomes. A resolution or sweep failure for one Repository is recorded
 * on its own result entry and does not prevent the others from running.
 */
export interface RepositorySweepCoordinator {
  execute(workerId: import('@ai-sdlc/domain').WorkerId): Promise<RepositorySweepCoordinatorResult>;
}
import {
  AgentRuntimeRouter,
  OpenCodeAgentAdapter,
  PiAgentAdapter,
  AntigravityAgentAdapter,
  ClaudeCodeAgentAdapter,
  CodexAgentAdapter,
  RepositoryRegistryRepository,
  StructuredResultRepair,
  deleteWorktreeFile,
} from '@ai-sdlc/infrastructure';
import { createArtifactCapturingAgent } from './durable-agent-artifacts.js';
import { buildReviewFixFixPrompt } from './review-fix-prompts.js';
import {
  getPostPrReviewCommitPolicy,
  WORKSPACE_CONSTRAINTS,
  SCRATCH_FILE_POLICY,
  type SelectedPrReviewContext,
  type SelectedPrReviewContextSection,
  isProtectedFilePath,
} from '@ai-sdlc/application';

/**
 * Bounded Least Recently Used (LRU) Map implementation.
 * Evicts the least recently accessed/inserted entry when capacity is exceeded.
 */
class LruMap<K, V> {
  private readonly map = new Map<K, V>();
  readonly maxSize: number;

  constructor(maxSize: number = 1000) {
    if (maxSize <= 0) {
      throw new RangeError('maxSize must be greater than 0');
    }
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) {
      return undefined;
    }
    const value = this.map.get(key)!;
    // Refresh recency by re-inserting at the end of the Map iteration order
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, value);
    return this;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }
}

async function readTail(filePath: string, maxBytes: number = 65536): Promise<string> {
  try {
    if (!filePath) {
      return '';
    }
    try {
      await fsAccess(filePath);
    } catch {
      return '';
    }
    const stat = await fsStat(filePath);
    if (stat.size === 0) {
      return '';
    }
    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const fd = await fsOpen(filePath, 'r');
    try {
      await fd.read(buffer, 0, bytesToRead, stat.size - bytesToRead);
    } finally {
      await fd.close();
    }
    return buffer.toString('utf-8');
  } catch (err) {
    console.warn(`[resolveInvocation] failed to read tail of ${filePath}:`, err);
    return '';
  }
}

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

export interface ExtractTaskTextResult {
  ok: boolean;
  text: string;
  error?: string;
  reason?: 'read_failed' | 'missing_heading' | 'inside_balanced_fence_only';
}

export function extractTaskText(
  planPath: string,
  taskIndex: number,
  manifest?: TaskManifest,
): ExtractTaskTextResult {
  let content: string;
  try {
    content = readFileSync(planPath, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      text: '',
      error: `Failed to read plan.md at ${planPath}: ${err instanceof Error ? err.message : String(err)}`,
      reason: 'read_failed',
    };
  }
  const task = manifest?.tasks.find((t) => t.n === taskIndex);
  const result = extractTaskBody(content, {
    taskNumber: taskIndex,
    ...(task?.title !== undefined ? { title: task.title } : {}),
  });
  if (result.ok) {
    return { ok: true, text: result.body.trim() };
  }
  return {
    ok: false,
    text: '',
    error: `Task ${taskIndex} has no matching heading in plan.md`,
    reason: result.reason,
  };
}

export interface MaybeRetryTransientRevalidationFlakeInput {
  runId: string;
  stepIndex?: number | undefined;
  manifest?: TaskManifest | undefined;
  taskValidationCommands: ValidationCommand[];
  failingCommands: ValidationRunCommandItem[];
  revalidateLogDir: string;
  cwd: string;
  repoId: string;
  config: OrchestratorConfig;
  runValidation: RunValidation;
  validationAdapter: ValidationPort;
  eventBus?: EventBusPort | undefined;
  effectiveCommands?: ValidationCommand[] | undefined;
  effectiveTiers?: string[][] | undefined;
  validationScope?: ValidationScopeSummary | undefined;
}

export async function maybeRetryTransientRevalidationFlake(
  input: MaybeRetryTransientRevalidationFlakeInput,
): Promise<{
  passed: boolean;
  failingCommands: ValidationRunCommandItem[];
  retried: boolean;
}> {
  const failedTestFiles = new Set<string>();
  for (const c of input.failingCommands) {
    const stdoutAbs = c.stdoutPath
      ? isAbsolute(c.stdoutPath)
        ? c.stdoutPath
        : join(input.revalidateLogDir, basename(c.stdoutPath))
      : '';
    const stderrAbs = c.stderrPath
      ? isAbsolute(c.stderrPath)
        ? c.stderrPath
        : join(input.revalidateLogDir, basename(c.stderrPath))
      : '';
    const [stdoutTail, stderrTail] = await Promise.all([readTail(stdoutAbs), readTail(stderrAbs)]);
    const extracted = extractFailedTestFilesFromOutput(stdoutTail + '\n' + stderrTail);
    for (const f of extracted) {
      failedTestFiles.add(f);
    }
  }

  if (failedTestFiles.size === 0) {
    if (input.eventBus) {
      input.eventBus.publish(input.runId, {
        runId: input.runId,
        level: 'warn',
        type: 'revalidation.flake_retry_skipped',
        message: 'Revalidation flake retry skipped: no failed test files parsed from output',
        timestamp: new Date().toISOString(),
        metadata: {
          reason: 'no_failures',
          failedTestFiles: [],
        },
      });
    }
    return { passed: false, failingCommands: input.failingCommands, retried: false };
  }

  let taskDeclaredFiles: string[] = [];
  if (input.manifest && typeof input.stepIndex === 'number' && input.stepIndex > 0) {
    taskDeclaredFiles = declaredFilesForStep(input.manifest, input.stepIndex);
  }

  const taskCommandTargets = new Set<string>();
  for (const cmd of input.taskValidationCommands) {
    const cmdStr = Array.isArray(cmd) ? cmd.join(' ') : String(cmd);
    for (const f of failedTestFiles) {
      if (cmdStr.includes(f)) {
        taskCommandTargets.add(f);
      }
    }
  }

  const inScopeFiles = new Set([...taskDeclaredFiles, ...taskCommandTargets]);
  for (const f of failedTestFiles) {
    if (inScopeFiles.has(f)) {
      return { passed: false, failingCommands: input.failingCommands, retried: false };
    }
  }

  const outOfScopeFailures = Array.from(failedTestFiles).filter((f) => !inScopeFiles.has(f));

  if (outOfScopeFailures.length > 5) {
    if (input.eventBus) {
      input.eventBus.publish(input.runId, {
        runId: input.runId,
        level: 'warn',
        type: 'revalidation.flake_retry_skipped',
        message: `Revalidation flake retry skipped: too many failed test files (${outOfScopeFailures.length} > 5)`,
        timestamp: new Date().toISOString(),
        metadata: {
          reason: 'too_many_failures',
          failedTestFiles: outOfScopeFailures,
        },
      });
    }
    return { passed: false, failingCommands: input.failingCommands, retried: false };
  }

  const isolatedLogDir = join(input.revalidateLogDir, 'isolation-check');
  for (const testFile of outOfScopeFailures) {
    const isolatedCmd = await buildTargetedTestCommand(testFile, input.config.validation.commands, {
      worktreeRoot: input.cwd,
      readWorktreeFile: (rel) => {
        try {
          return readFileSync(resolve(input.cwd, rel), 'utf-8');
        } catch {
          return null;
        }
      },
      onDiagnostic: (diag) => {
        if (input.eventBus) {
          input.eventBus.publish(input.runId, {
            runId: input.runId,
            level: 'warn',
            type: 'revalidation.targeted_test_command_suppressed',
            message: diag,
            timestamp: new Date().toISOString(),
            metadata: { testFile },
          });
        }
      },
    });
    if (!isolatedCmd) {
      return { passed: false, failingCommands: input.failingCommands, retried: false };
    }
    try {
      const isolationRes = await input.validationAdapter.run({
        cwd: input.cwd,
        logDir: isolatedLogDir,
        commands: [isolatedCmd],
        timeoutSeconds: input.config.validation.timeout,
        env: { GITHUB_REPOSITORY: input.repoId },
      });
      if (isolationRes.some((res) => res.outcome !== 'passed')) {
        return { passed: false, failingCommands: input.failingCommands, retried: false };
      }
    } catch {
      return { passed: false, failingCommands: input.failingCommands, retried: false };
    }
  }

  if (input.eventBus) {
    input.eventBus.publish(input.runId, {
      runId: input.runId,
      level: 'warn',
      type: 'revalidation.transient_flake_retry',
      message: `Mid-implement revalidation failure on out-of-scope test(s) [${Array.from(failedTestFiles).join(', ')}] passed in isolation; retrying revalidation once`,
      timestamp: new Date().toISOString(),
      metadata: { failedTestFiles: Array.from(failedTestFiles) },
    });
  }

  const retryLogDir = join(input.revalidateLogDir, 'flake-retry');
  const effectiveCommands = input.effectiveCommands ?? input.config.validation.commands;
  const effectiveTiers = input.effectiveTiers ?? input.config.validation.tiers;
  const vrRetry = await input.runValidation.execute({
    runId: RunId(input.runId),
    phaseId: PhaseName('validate'),
    cwd: input.cwd,
    logDir: retryLogDir,
    commands: [...effectiveCommands, ...input.taskValidationCommands],
    ...(effectiveTiers ? { tiers: effectiveTiers } : {}),
    timeoutSeconds: input.config.validation.timeout,
    env: { GITHUB_REPOSITORY: input.repoId },
    ...(input.validationScope ? { validationScope: input.validationScope } : {}),
  });

  const evalRetry = await evaluateRevalidationWithInvertedCommands({
    validationRunCommands: vrRetry.validationRun.commands,
    taskValidationCommands: input.taskValidationCommands,
    readTail: async (path) => {
      const absPath = isAbsolute(path) ? path : join(retryLogDir, basename(path));
      return readTail(absPath);
    },
  });

  return {
    passed: evalRetry.passed,
    failingCommands: evalRetry.failingCommands,
    retried: true,
  };
}

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
  executionPolicy: ExecutionPolicy;
  runExecutor?: RunExecutor;
  runNotification?: RunNotificationPort;
  reapOrphanedTestWorkers: ReapOrphanedTestWorkers;
  eventRepository: EventRepository;
  artifactRepository: ArtifactRepository;
  failureRepository: FailureRepository;
  agentInvocationRepository: AgentInvocationRepository;
  validationRunRepository: ValidationRunRepository;
  prReviewRepository: PrReviewRepository;
  loopRepository: LoopRepository;
  workerLeaseRepository: WorkerLeaseRepository;
  jobQueue: JobQueuePort;
  workerRegistry?: WorkerRegistryPort;
  /**
   * A worker is bound to exactly one repository for its active lifetime
   * (#651 invariant: worker_assignment_is_immutable_while_active), so the
   * deps a worker loop needs are repo-scoped, not shared across repos.
   * Callers build one worker identity + one deps object per repository
   * they want to service concurrently (see the `serve` command).
   */
  workerLoopDeps?: (repoId: RepositoryId) => Omit<WorkerLoopDeps, 'recoverableRunIds'>;
  serveSweepIntervalSeconds: number;
  schedulerConfig: SchedulerConfig;
  /** @deprecated Root-scoped sweeper; use `buildRepositorySweepCoordinator` for multi-Repository recovery sweeps (#652 Task 6). Retained until Task 7 rewires `serve`. */
  buildWaitingRunsSweeper: () => import('@ai-sdlc/application').WaitingRunsSweeper;
  /** @deprecated Root-scoped sweeper; use `buildRepositorySweepCoordinator` for multi-Repository recovery sweeps (#652 Task 6). Retained until Task 7 rewires `serve`. */
  buildOrphanedRunsSweeper: () => import('@ai-sdlc/application').OrphanedRunsSweeper;
  /**
   * Builds a coordinator that resolves every enabled Repository via the
   * `runtimeCatalog` and runs the waiting/orphan recovery sweeps against
   * each Repository's own operational runtime (Run/queue/lease/event
   * ports) rather than the root container's ports. One Repository's
   * resolution or sweep failure does not block the others (#652 Task 6).
   */
  buildRepositorySweepCoordinator: () => RepositorySweepCoordinator;
  /** Exposed for worktree lifecycle management in CLI and tests. */
  git: GitPort;
  /** Context factory for a full run (includes promptsRoot, expectedBranch, cwd). Only present when agent config is loaded. */
  buildRunContext?: (run: Run) => PhaseHandlerContext;
  repoFullName: string;
  targetRepoRoot: string;
  runValidation: RunValidation;
  startIssueRun: StartIssueRun;
  loadRepositoryForRun: LoadRepositoryForRun;
  runAbort: RunAbortPort;
  cancelRun: CancelRun;
  checkMergeReadiness: CheckMergeReadiness;
  stepRepository: StepRepositoryPort;
  resumeRun: ResumeRun;
  retryFailedPhase: RetryFailedPhase;
  runsDir: string;
  baseTmpDir: string;
  defaultBranch: string;
  repoDefaultBranch: string;
  eventBus: EventBusPort;
  /** @deprecated Use `resolveProfileForPhase()` instead */
  agentRuntime?: AgentRuntimeRouter;
  resolveProfileForPhase: (phaseName: string) => AgentProfileName;
  buildPhaseHandlerContext: PhaseHandlerContextFactory;
  validateFixLoop?: ValidateFixLoop;
  buildPrReviewPoller: (opts: {
    maxPolls: number;
    pollIntervalMs: number;
    readyMaxDays: number;
    phaseStartedAt: Date;
    baseBranch?: string;
    repoRoot?: string;
    firstReviewGraceWindowSeconds?: number;
  }) => PrReviewPoller;
  createFileTailer: (
    opts: import('@ai-sdlc/application/ports').FileTailerOptions,
  ) => import('@ai-sdlc/application/ports').FileTailerPort;
  repositoryRegistry: RepositoryRegistryPort;
  listRepositories: ListRepositories;
  inspectRepository: InspectRepository;
  registerRepository: RegisterRepository;
  updateRepository: UpdateRepository;
  enableRepository: EnableRepository;
  disableRepository: DisableRepository;
  refreshRepository: RefreshRepository;
  removeRepository: RemoveRepository;
  runtimeCatalog: RepositoryRuntimeCatalog;
  /**
   * Promise that completes when startup recovery sweeps finish.
   * Awaited by CLI exit handlers before draining notifications to ensure
   * any terminal notifications triggered by offline merged PRs are registered.
   */
  startupSweepPromise?: Promise<unknown> | undefined;
  drainStartupSweeps?: (timeoutMs?: number) => Promise<void>;
  trackStartupSweep?: (promise: Promise<unknown>) => void;
}

export interface ComposeOptions {
  repoRoot: string;
  /**
   * Target repository root for worktrees, DB, and git/gh cwd operations.
   * Defaults to `repoRoot` when unset. Prompts, config, and scripts
   * always come from `repoRoot` regardless of this value.
   */
  targetRepoRoot?: string;
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
  /** Inject repo full name (for tests; skips gh CLI resolution) */
  repoFullName?: string;
  /** Inject metadata resolver (for tests) */
  metadataResolver?: {
    resolve(path: string): import('@ai-sdlc/infrastructure').RepositoryMetadata;
  };
  /** Override specific runtime adapters with test doubles or custom implementations */
  agentAdapterOverrides?: Partial<Record<import('@ai-sdlc/domain').AgentRuntimeKind, AgentPort>>;
  /** Use a custom validation adapter instead of ProcessValidationAdapter */
  validationPort?: ValidationPort;
}

class AbortRegistry implements RunAbortPort {
  private readonly entries = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();

  register(runId: string, controller: AbortController, done: Promise<void>): void {
    this.entries.set(runId, { controller, done });
  }

  async abort(runId: string): Promise<import('@ai-sdlc/application').AbortResult> {
    const entry = this.entries.get(runId);
    if (!entry) {
      return { status: 'not_found' };
    }
    entry.controller.abort();
    let timer: NodeJS.Timeout;
    const timeout = new Promise<{ status: 'timed_out' }>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'timed_out' }), 30_000);
    });
    const donePromise = entry.done
      .then(() => ({ status: 'exited' as const }))
      .catch(() => ({ status: 'exited' as const }));

    const res = await Promise.race([donePromise, timeout]).finally(() => clearTimeout(timer));
    return res;
  }

  unregister(runId: string): void {
    this.entries.delete(runId);
  }
}

class SingleRepoAdapter implements RepositoryPort {
  constructor(private readonly repo: Repository) {}

  findById(id: RepositoryId): Repository | undefined {
    return this.repo.id === id ? this.repo : undefined;
  }

  findByFullName(fullName: string): Repository | undefined {
    return this.repo.fullName === fullName ? this.repo : undefined;
  }

  findByLocalPath(localBasePath: string): Repository | undefined {
    return this.repo.localBasePath === localBasePath ? this.repo : undefined;
  }
  listAll(): Repository[] {
    return [this.repo];
  }
  listEnabled(): Repository[] {
    return this.repo.enabled ? [this.repo] : [];
  }
}

type DeclaredTaskFileFields = {
  expected_files?: string[] | null;
  files?: string[] | null;
};

export function declaredFilesForStep(manifest: TaskManifest, stepIndex: number): string[] {
  const task = manifest.tasks[stepIndex - 1] as DeclaredTaskFileFields | undefined;
  if (!task) return [];
  const files: string[] = [];
  if (Array.isArray(task.expected_files)) {
    files.push(...task.expected_files.filter((f): f is string => typeof f === 'string'));
  }
  if (Array.isArray(task.files)) {
    files.push(...task.files.filter((f): f is string => typeof f === 'string'));
  }
  return files;
}

export interface BuildPostPrReviewTaskPromptInput {
  cwd: string;
  comment: PrReviewComment;
  diff: string;
  mode: 'initial_full' | 'intermediate_delta';
  previousBuildError?: string;
  previousCodeVerifyReason?: string;
  dispositions?: Array<{
    disposition: string;
    reason?: string;
  }>;
}

export function buildPostPrReviewTaskPrompt(input: BuildPostPrReviewTaskPromptInput): string {
  const { cwd, comment, diff, mode, previousBuildError, previousCodeVerifyReason, dispositions } =
    input;
  const sections: string[] = [
    '# PR Review Comment Task',
    '',
    WORKSPACE_CONSTRAINTS,
    '',
    SCRATCH_FILE_POLICY,
    '',
    `## Attempt Mode: ${mode === 'initial_full' ? 'INITIAL FULL' : 'INTERMEDIATE DELTA'}`,
    '',
    'Address the following PR review comment:',
    '',
    `- [commentId: ${comment.commentId}] ${comment.path}:${comment.line} - ${comment.body}`,
    '',
    '## Current Diff',
    '',
    diff,
    '',
  ];

  if (previousBuildError !== undefined) {
    const truncatedError =
      previousBuildError.length > 4000
        ? previousBuildError.slice(0, 2000) +
          '\n... (truncated) ...\n' +
          previousBuildError.slice(-2000)
        : previousBuildError;
    sections.push(
      '## Previous Attempt Failed',
      '',
      'The previous fix attempt failed the build with the following error:',
      '',
      '```',
      truncatedError,
      '```',
      '',
      'Please adjust your fix to resolve this error.',
      '',
    );
  }

  if (previousCodeVerifyReason !== undefined) {
    sections.push(
      '## Previous Fix Rejected by Code Verifier',
      '',
      'An independent verifier reviewed your previous fix and rejected it with this reason:',
      '',
      `> ${previousCodeVerifyReason}`,
      '',
      'Please revisit your fix with this feedback in mind before trying again.',
      '',
    );
  }

  if (mode === 'intermediate_delta' && dispositions && dispositions.length > 0) {
    sections.push(
      '## Prior Attempt Dispositions',
      '',
      ...dispositions.map((d) => `- ${d.disposition}: ${d.reason ?? 'no reason'}`),
      '',
    );
  }

  sections.push(
    getPostPrReviewCommitPolicy(false),
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
    '  "blockedReason": "<string - only when action is blocked>"',
    '}',
    '```',
    '',
    'Only write a fixed action in result.json after verifying HEAD advanced and worktree is clean.',
  );

  return sections.join('\n');
}

export interface BuildPostPrReviewBatchPromptInput {
  cwd: string;
  comments: readonly PrReviewComment[];
  context: SelectedPrReviewContext;
  attempt: number;
  dispositions: ReadonlyArray<{
    commentId: number;
    fingerprint: string;
    disposition: string;
    reason?: string;
  }>;
  previousBuildError?: string;
  previousCodeVerifyReason?: string;
}

function renderContextSection(section: SelectedPrReviewContextSection): string {
  switch (section.kind) {
    case 'summary':
      return `## Context Summary\n\n${section.content}`;
    case 'hunk':
      return `## Hunk: ${section.path}:${section.lineStart}-${section.lineEnd}\n\n\`\`\`diff\n${section.content}\n\`\`\``;
    case 'source':
      return `## Source: ${section.path}${section.lineStart != null ? `:${section.lineStart}` : ''}\n\n\`\`\`\n${section.content}\n\`\`\``;
    case 'symbol':
      return `## Symbol: ${section.path}\n\n\`\`\`\n${section.content}\n\`\`\``;
    case 'test':
      return `## Related Test: ${section.path}\n\n${section.content}`;
    case 'related-diff':
      return `## Related Diff: ${section.path}:${section.lineStart ?? 0}\n\n\`\`\`diff\n${section.content}\n\`\`\``;
    case 'full-diff':
      return `## Full Diff (${section.content.length} chars)\n\n\`\`\`diff\n${section.content}\n\`\`\``;
    default:
      return '';
  }
}

export function buildPostPrReviewBatchPrompt(input: BuildPostPrReviewBatchPromptInput): string {
  const {
    cwd,
    comments,
    context,
    attempt,
    dispositions,
    previousBuildError,
    previousCodeVerifyReason,
  } = input;
  const sections: string[] = [];

  sections.push(
    '# PR Review Batch Task',
    '',
    WORKSPACE_CONSTRAINTS,
    '',
    SCRATCH_FILE_POLICY,
    '',
    `## Attempt: ${attempt}`,
    '',
  );

  sections.push(
    '## Context Provenance',
    '',
    `- level: ${context.level}`,
    `- includedFiles: ${context.includedFiles.join(', ') || '(none)'}`,
    `- includedHunks: ${context.includedHunks.join(', ') || '(none)'}`,
    `- includedSymbols: ${context.includedSymbols.join(', ') || '(none)'}`,
    `- fullDiffIncluded: ${context.fullDiffIncluded}`,
    '',
  );

  if (context.fullDiffIncluded && context.fallbackReason) {
    sections.push(`## CONTEXT FALLBACK`, '', `fallbackReason: ${context.fallbackReason}`, '');
  }

  if (context.sections.length > 0) {
    sections.push('## Context Sections', '');
    for (const section of context.sections) {
      if (section.kind === 'full-diff' && !context.fullDiffIncluded) {
        continue;
      }
      sections.push(renderContextSection(section), '');
    }
  }

  sections.push(getPostPrReviewCommitPolicy(true), '');

  if (previousBuildError !== undefined) {
    const truncatedError =
      previousBuildError.length > 4000
        ? previousBuildError.slice(0, 2000) +
          '\n... (truncated) ...\n' +
          previousBuildError.slice(-2000)
        : previousBuildError;
    sections.push(
      '## Previous Attempt Failed',
      '',
      'The previous fix attempt failed the build with the following error:',
      '',
      '```',
      truncatedError,
      '```',
      '',
      'Please adjust your fix to resolve this error.',
      '',
    );
  }

  if (previousCodeVerifyReason !== undefined) {
    sections.push(
      '## Previous Fix Rejected by Code Verifier',
      '',
      'An independent verifier reviewed your previous fix and rejected it with this reason:',
      '',
      `> ${previousCodeVerifyReason}`,
      '',
      'Please revisit your fix with this feedback in mind before trying again.',
      '',
    );
  }

  sections.push(
    '## Comments to Address',
    '',
    ...comments.map((c) => `- [commentId: ${c.commentId}] ${c.path}:${c.line} - ${c.body}`),
    '',
  );

  const dispositionsByCommentId = new Map<number, Array<(typeof dispositions)[0]>>();
  for (const d of dispositions) {
    const existing = dispositionsByCommentId.get(d.commentId);
    if (existing) {
      existing.push(d);
    } else {
      dispositionsByCommentId.set(d.commentId, [d]);
    }
  }

  if (dispositions.length > 0) {
    sections.push('## Prior Dispositions', '');
    for (const comment of comments) {
      const disps = dispositionsByCommentId.get(comment.commentId);
      if (disps && disps.length > 0) {
        sections.push(`### commentId: ${comment.commentId}`);
        for (const disp of disps) {
          sections.push(
            `- disposition: ${disp.disposition}`,
            `  reason: ${disp.reason ?? 'no reason'}`,
          );
        }
        sections.push('');
      }
    }
  }

  sections.push(
    '## Required Output',
    '',
    `Write a result.json file at: ${join(cwd, 'result.json')}`,
    '',
    'Return a JSON array with one entry per commentId listed above:',
    '',
    '```json',
    '[',
    '  { "commentId": <number>, "action": "fixed" | "no_fix" | "blocked", "replyBody": "<non-empty string>", "blockedReason": "<string - only when action is blocked>" },',
    '  ...',
    ']',
    '```',
    '',
    'Rules:',
    '- One array entry REQUIRED per listed commentId',
    '- commentId values must match exactly the IDs listed above',
    '- replyBody must be non-empty',
    '- blockedReason is only valid when action is "blocked"',
  );

  return sections.join('\n');
}

export function captureExecOutput(err: unknown): string {
  if (err instanceof Error && 'stdout' in err && 'stderr' in err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const stdout = String(e.stdout ?? '');
    const stderr = String(e.stderr ?? '');
    return stdout && stderr ? `${stdout}\n${stderr}` : stdout || stderr;
  }
  return String(err);
}

const DEFAULT_LEASE_TTL_MS = 120_000;

const layeredConfigCache = new Map<string, LoadedConfig>();

function applyCliOverrides(
  config: OrchestratorConfig,
  opts: { baseBranch?: string; model?: string; agentCli?: string },
): OrchestratorConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const next: any = JSON.parse(JSON.stringify(config));
  if (opts.baseBranch) {
    if (!next.repository) next.repository = {};
    next.repository.baseBranch = opts.baseBranch;
  }
  if (opts.model) {
    if (!next.agent) next.agent = {};
    next.agent.model = opts.model;
  }
  if (opts.agentCli) {
    if (!next.agent) next.agent = {};
    next.agent.cli = opts.agentCli;
  }
  return next as OrchestratorConfig;
}

export function composeRoot(opts: ComposeOptions): Container {
  const effectiveRepoRoot = findRepoRoot(opts.repoRoot);
  const effectiveTargetRepoRoot =
    opts.targetRepoRoot ?? (opts.repoRoot !== effectiveRepoRoot ? opts.repoRoot : undefined);

  if (process.env.VITEST && !existsSync(join(effectiveRepoRoot, '.ai-orchestrator.json'))) {
    try {
      writeFileSync(
        join(effectiveRepoRoot, '.ai-orchestrator.json'),
        JSON.stringify({
          validation: { commands: ['echo 1'], timeout: 10 },
          phases: {
            skip: [],
            reviewFix: { maxIterations: 1 },
            implement: { maxIterations: 1 },
          },
          timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
        }),
      );
    } catch {
      // Best effort in test environments
    }
  }

  // `targetRoot` is the directory the orchestrator operates ON
  // (worktrees, DB, git/gh cwd). It is normally the same as the
  // orchestrator repo, but may be overridden via `opts.targetRepoRoot`
  // for cross-repo orchestration.
  //
  // IMPORTANT: `opts.repoRoot` (not `targetRoot`) is still the source of
  // truth for prompts, config, and scripts — those always come from the
  // automation repo, not the target.
  const targetRoot = effectiveTargetRepoRoot ?? effectiveRepoRoot;
  const runsDir = opts.runsDir ?? join(targetRoot, '.ai-runs');
  const envTmpdir = process.env.TMPDIR?.trim();
  const baseTmpDir =
    opts.baseTmpDir ?? (envTmpdir ? join(envTmpdir, '.ai-tmp') : join(dirname(runsDir), '.ai-tmp'));
  mkdirSync(baseTmpDir, { recursive: true });
  const db = openDatabase(opts.dbPath ?? join(runsDir, 'orchestrator.sqlite'));
  applyMigrations(db);

  const resolver = opts.metadataResolver ?? new RepositoryMetadataResolver();
  let metadata: import('@ai-sdlc/infrastructure').RepositoryMetadata;
  try {
    metadata = resolver.resolve(targetRoot);
  } catch (err) {
    // An explicit target is authoritative: never mask its resolution failure
    // with ambient GITHUB_REPOSITORY or placeholder metadata.
    if (opts.targetRepoRoot !== undefined) {
      throw new Error(
        `Failed to resolve repository metadata for --target-repo-root ${targetRoot}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    // Legacy fallback: if resolution fails, try to use GITHUB_REPOSITORY
    // or placeholder values for tests that use non-git tmp dirs.
    const nameWithOwner = opts.repoFullName ?? process.env.GITHUB_REPOSITORY ?? 'unknown/unknown';
    metadata = {
      rootPath: targetRoot,
      nameWithOwner,
      defaultBranch: 'main',
      remoteUrl: '',
    };
  }
  const resolvedDefaultBranch = metadata.defaultBranch;
  const resolvedRepoFullName =
    metadata.nameWithOwner !== 'unknown/unknown' ? metadata.nameWithOwner : undefined;
  const resolvedRemoteUrl = metadata.remoteUrl;

  const repoId = resolvedRepoFullName ? RepositoryId(resolvedRepoFullName) : ('' as RepositoryId);

  const singleRepo: RepositoryPort = resolvedRepoFullName
    ? new SingleRepoAdapter({
        id: repoId,
        owner: resolvedRepoFullName.split('/')[0]!,
        name: resolvedRepoFullName.split('/')[1]!,
        fullName: resolvedRepoFullName,
        defaultBranch: resolvedDefaultBranch,
        remoteUrl: resolvedRemoteUrl,
        localBasePath: targetRoot,
        enabled: true,
        maxConcurrentRuns: 1 as const,
        healthStatus: 'unknown',
        healthError: null,
        lastHealthCheckAt: null,
        configMetadata: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    : new SingleRepoAdapter({
        id: repoId,
        owner: '',
        name: '',
        fullName: '',
        defaultBranch: '',
        remoteUrl: '',
        localBasePath: '',
        enabled: false,
        maxConcurrentRuns: 1 as const,
        healthStatus: 'unknown',
        healthError: null,
        lastHealthCheckAt: null,
        configMetadata: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

  let artifactStoreForRun: (runUuid: string, worktreeRoot: string) => ArtifactStore;

  interface RepositoryRow {
    id: string;
    full_name: string;
    owner: string;
    name: string;
    local_base_path: string;
    default_branch: string;
    remote_url: string;
    enabled: number;
    max_concurrent_runs: number;
    config_metadata: string;
    health_status: string;
    health_error: string | null;
    last_health_check_at: string | null;
    created_at: string;
    updated_at: string;
  }

  function mapRowToRepo(row: RepositoryRow): import('@ai-sdlc/domain').Repository {
    return {
      id: RepositoryId(row.id),
      fullName: row.full_name,
      owner: row.owner,
      name: row.name,
      localBasePath: row.local_base_path,
      defaultBranch: row.default_branch,
      remoteUrl: row.remote_url,
      enabled: row.enabled === 1,
      maxConcurrentRuns: 1,
      configMetadata: row.config_metadata,
      healthStatus: row.health_status as import('@ai-sdlc/domain').RepositoryHealthStatus,
      healthError: row.health_error,
      lastHealthCheckAt: row.last_health_check_at ? new Date(row.last_health_check_at) : null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  const registryReadRepo: RepositoryPort = {
    findById: (id) => {
      const row = db.prepare(`SELECT * FROM repositories WHERE id = ?`).get(id) as
        | RepositoryRow
        | undefined;
      return row ? mapRowToRepo(row) : undefined;
    },
    findByFullName: (n) => {
      const row = db.prepare(`SELECT * FROM repositories WHERE full_name = ?`).get(n) as
        | RepositoryRow
        | undefined;
      return row ? mapRowToRepo(row) : undefined;
    },
    findByLocalPath: (p) => {
      const row = db.prepare(`SELECT * FROM repositories WHERE local_base_path = ?`).get(p) as
        | RepositoryRow
        | undefined;
      return row ? mapRowToRepo(row) : undefined;
    },
    listAll: () => {
      const rows = db.prepare(`SELECT * FROM repositories`).all() as RepositoryRow[];
      return rows.map(mapRowToRepo);
    },
    listEnabled: () => {
      const rows = db
        .prepare(`SELECT * FROM repositories WHERE enabled = 1`)
        .all() as RepositoryRow[];
      return rows.map(mapRowToRepo);
    },
  };

  const registryBackedRepo: RepositoryPort = {
    findById: (id) => {
      const row = db.prepare(`SELECT * FROM repositories WHERE id = ?`).get(id) as
        | RepositoryRow
        | undefined;
      if (row) return mapRowToRepo(row);
      return singleRepo.findById(id);
    },
    findByFullName: (n) => {
      const row = db.prepare(`SELECT * FROM repositories WHERE full_name = ?`).get(n) as
        | RepositoryRow
        | undefined;
      if (row) return mapRowToRepo(row);
      return singleRepo.findByFullName(n);
    },
    findByLocalPath: (p) => {
      const row = db.prepare(`SELECT * FROM repositories WHERE local_base_path = ?`).get(p) as
        | RepositoryRow
        | undefined;
      if (row) return mapRowToRepo(row);
      return singleRepo.findByLocalPath(p);
    },
    listAll: () => {
      const rows = db.prepare(`SELECT * FROM repositories`).all() as RepositoryRow[];
      if (rows.length > 0) return rows.map(mapRowToRepo);
      return singleRepo.listAll();
    },
    listEnabled: () => {
      const rows = db
        .prepare(`SELECT * FROM repositories WHERE enabled = 1`)
        .all() as RepositoryRow[];
      if (rows.length > 0) return rows.map(mapRowToRepo);
      return singleRepo.listEnabled();
    },
  };

  let fingerprint: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sources: any;
  let executionPolicy: ExecutionPolicy = 'standard';
  try {
    const cacheKey = `${effectiveRepoRoot}|${effectiveTargetRepoRoot ?? ''}`;
    let layered = layeredConfigCache.get(cacheKey);
    if (!layered) {
      layered = loadLayeredConfig({
        automationRoot: effectiveRepoRoot,
        ...(effectiveTargetRepoRoot !== undefined ? { targetRoot: effectiveTargetRepoRoot } : {}),
      });
      layeredConfigCache.set(cacheKey, layered);
    }
    fingerprint = layered.fingerprint;
    sources = layered.sources;
    executionPolicy = layered.config.executionPolicy ?? 'standard';
  } catch {
    // Ignore error here; the main config loader below will throw if config is invalid/missing.
  }

  const runRepository = new RunRepository(
    db,
    fingerprint,
    sources ? JSON.stringify(sources) : undefined,
    executionPolicy,
  );
  const artifactRepository = new ArtifactRepository(db);
  const prReviewRepository = new PrReviewRepository(db);
  const eventBus = new InMemoryEventBus();

  const eventRepositoryCache = new Map<RepositoryId, EventRepository>();
  const getEventRepository = (rId: RepositoryId): EventRepository => {
    let repo = eventRepositoryCache.get(rId);
    if (!repo) {
      repo = new EventRepository(db, rId);
      eventRepositoryCache.set(rId, repo);
    }
    return repo;
  };
  const eventRepository = getEventRepository(repoId);
  const eventRepositoryFactory: EventRepositoryFactory = getEventRepository;

  const runRepoIdCache = new LruMap<string, RepositoryId>(1000);

  const persistingEventBus: EventBusPort = {
    subscribe: (runUuid, listener) => eventBus.subscribe(runUuid, listener),
    publish: (runUuid, event) => {
      eventBus.publish(runUuid, event);
      try {
        let rId = runRepoIdCache.get(runUuid);
        if (rId === undefined) {
          const run = runRepository.findByUuid(runUuid);
          if (run) {
            rId = run.repoId;
            runRepoIdCache.set(runUuid, rId);
          } else {
            rId = repoId;
          }
        }
        eventRepositoryFactory(rId).insert({
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
      } catch (err) {
        // Best-effort: event persistence must not crash callers, but log error for diagnostics
        console.error('Failed to persist event:', err);
      }
    },
  };

  const resolvePrContextForRun = async (
    run: RunRecord,
  ): Promise<{ repoFullName: string; prNumber: number } | undefined> => {
    const artifactRoot = run.displayId ?? run.uuid;
    try {
      const prUrl = readFileSync(
        join(runsDir, artifactRoot, 'phase-artifacts', 'pr-url.txt'),
        'utf8',
      ).trim();
      const match = prUrl.match(/\/pull\/(\d+)/);
      if (!match) return undefined;
      const repo = registryBackedRepo.findById(run.repoId);
      const repoFullName = repo ? repo.fullName : (resolvedRepoFullName ?? run.repoId);
      return { repoFullName, prNumber: parseInt(match[1]!, 10) };
    } catch {
      return undefined;
    }
  };

  const reapOrphanedTestWorkers = new ReapOrphanedTestWorkers({ listProcesses, killProcess });

  let readyMaxDays = 7;
  let serveSweepIntervalSeconds = 0;
  try {
    const cacheKey = `${effectiveRepoRoot}|${effectiveTargetRepoRoot ?? ''}`;
    let sweepLayered = layeredConfigCache.get(cacheKey);
    if (!sweepLayered) {
      sweepLayered = loadLayeredConfig({
        automationRoot: effectiveRepoRoot,
        ...(effectiveTargetRepoRoot !== undefined ? { targetRoot: effectiveTargetRepoRoot } : {}),
      });
      layeredConfigCache.set(cacheKey, sweepLayered);
    }
    readyMaxDays = sweepLayered.config.timeouts.readyMaxDays;
    serveSweepIntervalSeconds = sweepLayered.config.serve.sweepIntervalSeconds;
  } catch {
    // Fallback to default 7 / disabled.
  }

  let schedulerConfig = { globalConcurrency: 1, pollIntervalMs: 2000, shutdownGraceMs: 30_000 };
  try {
    const cacheKey = `${effectiveRepoRoot}|${effectiveTargetRepoRoot ?? ''}`;
    let sweepLayered = layeredConfigCache.get(cacheKey);
    if (!sweepLayered) {
      sweepLayered = loadLayeredConfig({
        automationRoot: effectiveRepoRoot,
        ...(effectiveTargetRepoRoot !== undefined ? { targetRoot: effectiveTargetRepoRoot } : {}),
      });
      layeredConfigCache.set(cacheKey, sweepLayered);
    }
    schedulerConfig = sweepLayered.config.scheduler;
  } catch {
    // Fallback to defaults.
  }

  let ghAdapterForSweep: GhCliAdapter | undefined;
  const getGhAdapterForSweep = () => {
    if (!ghAdapterForSweep) {
      ghAdapterForSweep = new GhCliAdapter({});
    }
    return ghAdapterForSweep;
  };

  const sweepLogger: {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
  } = {
    // eslint-disable-next-line no-console
    debug: (msg, ...args) => console.debug(msg, ...args),
    // eslint-disable-next-line no-console
    info: (msg, ...args) => console.info(msg, ...args),
    warn: (msg, ...args) => console.warn(msg, ...args),
    error: (msg, ...args) => console.error(msg, ...args),
  };

  const phaseRepository = new PhaseRepository(db);
  const workerLeaseRepository = new WorkerLeaseRepository(db);
  const jobQueue: JobQueuePort = new JobQueueRepository(db, registryBackedRepo);

  const logger: {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
  } = {
    // eslint-disable-next-line no-console
    debug: (msg, ...args) => console.debug(msg, ...args),
    // eslint-disable-next-line no-console
    info: (msg, ...args) => console.info(msg, ...args),
    warn: (msg, ...args) => console.warn(msg, ...args),
    error: (msg, ...args) => console.error(msg, ...args),
  };

  let runWebhookUrl: string | undefined;
  try {
    const cacheKey = `${effectiveRepoRoot}|${effectiveTargetRepoRoot ?? ''}`;
    let cachedLayered = layeredConfigCache.get(cacheKey);
    if (!cachedLayered) {
      cachedLayered = loadLayeredConfig({
        automationRoot: effectiveRepoRoot,
        ...(effectiveTargetRepoRoot !== undefined ? { targetRoot: effectiveTargetRepoRoot } : {}),
      });
      layeredConfigCache.set(cacheKey, cachedLayered);
    }
    runWebhookUrl = cachedLayered.config.notifications?.runWebhookUrl;
  } catch {
    // Fallback if config absent or invalid
  }

  const runNotification: RunNotificationPort = runWebhookUrl
    ? new WebhookRunNotificationAdapter(runWebhookUrl, logger)
    : new NoopRunNotificationAdapter();

  let startupSweepPromise: Promise<unknown> | undefined;

  if (opts.runStartupSweeps !== false) {
    let orphanRecoveryPromise: Promise<unknown> | undefined;
    // Sweep orphaned runs before any new run starts
    const sweep = new SweepOrphanedRuns({
      runRepository,
      phaseRepository,
      isProcessAlive: checkPid,
      runNotification,
      logger: sweepLogger,
    });
    const sweepResult = sweep.execute();
    if (sweepResult.swept > 0) {
      console.error(`Recovered ${sweepResult.swept} orphaned run(s); enqueuing resume jobs`);
      // Enqueue recovery jobs for any runs whose owning process died between
      // the last serve-mode periodic sweep and this restart. The periodic
      // sweep in serve mode (cli.ts) handles the steady-state case; this
      // catches crashes that occurred while the orchestrator was offline.
      if (sweepResult.orphanedRuns.length > 0) {
        const orphanSweeper = new OrphanedRunsSweeper({
          runRepository,
          leases: workerLeaseRepository,
          queue: jobQueue,
          eventBus: persistingEventBus,
          now: () => new Date(),
          logger: sweepLogger,
        });
        orphanRecoveryPromise = orphanSweeper
          .execute(sweepResult.orphanedRuns)
          .then((orphanResult) => {
            if (
              orphanResult.enqueued > 0 ||
              orphanResult.skippedLeaseConflict > 0 ||
              orphanResult.skippedAlreadyQueued > 0 ||
              orphanResult.enqueueErrors.length > 0
            ) {
              console.error(
                `Orphan recovery: ${orphanResult.enqueued} enqueued, ${orphanResult.skippedLeaseConflict} skipped (lease), ${orphanResult.skippedAlreadyQueued} skipped (already queued), ${orphanResult.enqueueErrors.length} errors`,
              );
              for (const err of orphanResult.enqueueErrors) {
                console.error(`  Orphan enqueue error in run ${err.runId}: ${err.error}`);
              }
            }
          })
          .catch((err) => {
            console.error('Orphan recovery sweep error:', err);
          });
      }
    }

    // Sweep orphaned tmp dirs: remove .ai-tmp/<runId>/ where the runId
    // has no active or recent run, or the run is in a terminal state.
    sweepOrphanedTmpDirs(baseTmpDir, runRepository);

    // Reap orphaned vitest fork-pool workers (ppid==1, cmd matches /vitest/)
    // that were reparented to init when their original parent process died
    // uncleanly (crashed run, timed-out validation phase). Best-effort:
    // failures here must never block a run from starting.
    try {
      const reapResult = reapOrphanedTestWorkers.execute();
      if (reapResult.reaped > 0) {
        console.error(
          `Reaped ${reapResult.reaped} orphaned test worker(s): ${reapResult.pids.join(', ')}`,
        );
      }
    } catch (err) {
      console.error(
        `Orphaned test worker reap failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Sweep waiting runs: reactivate any run parked in `waiting` whose PR
    // has new review activity since the last poll attempt, or finalize
    // runs whose PRs were closed/merged while the orchestrator was
    // offline. Best-effort: a single broken run does not abort the sweep.
    const waitingSweep = new SweepWaitingRuns({
      runRepository,
      prReviewRepo: prReviewRepository,
      github: getGhAdapterForSweep(),
      eventBus: persistingEventBus,
      now: () => new Date(),
      readyMaxDays,
      runNotification,
      applyReactivation: (run: RunRecord, decision: { action: string; reason: string }) => {
        applyReactivation(run as never, decision as never, {
          runRepository,
          eventBus: persistingEventBus,
          now: () => new Date(),
        });
      },
      resolvePrContext: async (run: RunRecord) => resolvePrContextForRun(run),
    });
    const waitingSweepPromise = waitingSweep.execute().then(
      (waitingResult) => {
        if (
          waitingResult.reactivated > 0 ||
          waitingResult.timedOut > 0 ||
          waitingResult.passedOnMergedPr > 0 ||
          waitingResult.cancelledOnClosedPr > 0 ||
          waitingResult.errors.length > 0
        ) {
          console.error(
            `Reactivation sweep: ${waitingResult.reactivated} reactivated, ${waitingResult.timedOut} timed out, ${waitingResult.passedOnMergedPr} passed (merged PR), ${waitingResult.cancelledOnClosedPr} cancelled (closed PR), ${waitingResult.stayedReady} stayed ready, ${waitingResult.skipped} skipped, ${waitingResult.errors.length} errors`,
          );
        }
      },
      (err) => {
        console.error('Reactivation sweep error:', err);
      },
    );

    startupSweepPromise = orphanRecoveryPromise
      ? Promise.all([waitingSweepPromise, orphanRecoveryPromise])
      : waitingSweepPromise;
  }

  const failureRepository = new FailureRepository(db);
  const agentInvocationRepository = new AgentInvocationRepository(db);
  const validationRunRepository = new ValidationRunRepository(db);
  const agentUsageRepository = new AgentUsageRepository(db);
  const loopRepository = new LoopRepository(db);
  const validationAdapter = opts.validationPort ?? new ProcessValidationAdapter();
  const runValidation = new RunValidation({
    validation: validationAdapter,
    validationRunRepository,
    idFactory: () => randomUUID(),
    now: () => new Date(),
  });
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

  const loadRepositoryForRun = new LoadRepositoryForRun({ repositoryPort: registryBackedRepo });

  const deps: StartIssueRunDeps = {
    runRepository,
    failureRepository,
    classifyExit: classifyExitAdapter(agentInvocationRepository),
    runDirectoryFactory: ({ rootDir, run }) => RunDirectory.create({ rootDir, run }),
    runBashScript,
    runsDir,
    scriptPath: opts.scriptPath,
    eventRepository: eventRepositoryFactory,
    eventBus,
    createEventTailer,
    baseTmpDir,
    tmpDirectoryFactory,
    repositoryPort: registryBackedRepo,
    runNotification,
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
  const checkMergeReadiness = new CheckMergeReadiness({ prReviewRepo: prReviewRepository });

  const abortRegistry = new AbortRegistry();
  const gitAdapter = new GitWorktreeAdapter(orchestratorExcludePatterns());
  const worktreeLifecycleAdapter = new WorktreeLifecycleAdapter({
    isPreserved: isProtectedFilePath,
  });

  const cancelRun = new CancelRun({
    runRepository,
    logger,
    runAbort: abortRegistry,
    git: gitAdapter,
    leases: workerLeaseRepository,
    findCwd: (runId: RunId) => {
      const run = runRepository.findByUuid(runId);
      if (!run) throw new Error(`findCwd: no run found for ${runId}`);
      const repo = registryBackedRepo.findById(run.repoId);
      const repoRootPath = repo ? repo.localBasePath : targetRoot;
      return join(repoRootPath, '.ai-worktrees', `issue-${run.issueNumber}`);
    },
    findStartCommitSha: (runId: RunId) => {
      const run = runRepository.findByUuid(runId);
      if (!run) return 'HEAD';
      if (run.startCommitSha) return run.startCommitSha;
      const repo = registryBackedRepo.findById(run.repoId);
      const repoRootPath = repo ? repo.localBasePath : targetRoot;
      const repoDefaultBranch = repo ? repo.defaultBranch : resolvedDefaultBranch;
      const branchName = `ai/issue-${run.issueNumber}`;
      try {
        const sha = execFileSync('git', ['merge-base', branchName, `origin/${repoDefaultBranch}`], {
          cwd: repoRootPath,
        })
          .toString()
          .trim();
        if (sha) return sha;
      } catch {
        // Fall through to HEAD
      }
      return 'HEAD';
    },
  });

  const phaseRegistry = new PhaseHandlerRegistry();
  const stepRepository: StepRepositoryPort = new SqliteStepRepository(db);

  // Register the phase handler that does not require agent-mode dependencies
  phaseRegistry.register(new ReadIssueHandler());

  // Register lightweight unavailable stubs for agent-dependent phases so the
  // registry always contains all 10 canonical phases. Real handler instances
  // registered inside the if (config.agent) block below overwrite these.
  const stubPhases = [
    'plan-design',
    'plan-write',
    'implement',
    'validate',
    'fix-validate',
    'review-fix',
    'compound',
    'create-pr',
    'post-pr-review',
  ];
  for (const phase of stubPhases) {
    phaseRegistry.register({
      phase: PhaseName(phase),
      run: async (ctx) => {
        return {
          outcome: 'blocked' as const,
          failure: {
            runUuid: ctx.runUuid,
            phase,
            kind: 'handler_not_wired' as const,
            message: `Phase "${phase}" is not available: agent configuration required`,
            canRetry: true,
            suggestedAction: 'Add an agent section to .ai-orchestrator.json',
            artifacts: [] as string[],
            detectedAt: ctx.now(),
          },
        };
      },
    });
  }

  let agentRuntime: AgentRuntimeRouter | undefined;
  let capturingAgent: import('@ai-sdlc/application').AgentPort | undefined;
  let resolveProfileForPhaseBound: ((phaseName: string) => AgentProfileName) | undefined;
  let phaseContextRepair: import('@ai-sdlc/application').StructuredResultRepairPort | undefined;
  let validateFixLoop: ValidateFixLoop | undefined;
  let runExecutor: RunExecutor | undefined;
  let buildRunContext: ((run: Run) => PhaseHandlerContext) | undefined;
  let loadedSelfVerifyCommands: string[] | undefined;

  const readWorktreeFile: ReadWorktreeFilePort = async (cwd, relativePath) => {
    try {
      const resolvedCwd = resolve(cwd);
      const targetPath = resolve(resolvedCwd, relativePath);
      const rel = relative(resolvedCwd, targetPath);
      if (
        rel === '' ||
        rel === '..' ||
        rel.startsWith(`..${sep}`) ||
        rel.startsWith('../') ||
        isAbsolute(rel)
      ) {
        return undefined;
      }
      return await fsReadFile(targetPath, 'utf-8');
    } catch {
      return undefined;
    }
  };

  try {
    const cacheKey = `${effectiveRepoRoot}|${effectiveTargetRepoRoot ?? ''}`;
    let layered = layeredConfigCache.get(cacheKey);
    if (!layered) {
      layered = loadLayeredConfig({
        automationRoot: effectiveRepoRoot,
        ...(effectiveTargetRepoRoot !== undefined ? { targetRoot: effectiveTargetRepoRoot } : {}),
      });
      layeredConfigCache.set(cacheKey, layered);
    }
    let config = applyCliOverrides(layered.config, opts);
    loadedSelfVerifyCommands = config.validation.selfVerifyCommands;
    const _fingerprint = layered.fingerprint;
    const _sources = layered.sources;
    if (config.agent && config.agent.profiles) {
      const needsPi = Object.values(config.agent.profiles).some((p) => p.runtime === 'pi');
      const adapters: Partial<
        Record<import('@ai-sdlc/domain').AgentRuntimeKind, import('@ai-sdlc/application').AgentPort>
      > = {
        opencode: new OpenCodeAgentAdapter({
          artifactsDir: join(runsDir, 'agent-artifacts'),
          repoRoot: effectiveRepoRoot,
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
      Object.assign(adapters, opts.agentAdapterOverrides ?? {});
      agentRuntime = new AgentRuntimeRouter({
        agent: config.agent,
        adapters,
        invocationRepository: agentInvocationRepository,
        usageRepository: agentUsageRepository,
        eventBus: persistingEventBus,
      });
      const agent = config.agent;
      // Non-optional local so closures below can reference it
      // without a guard (the outer `let` stays `| undefined` for other consumers).
      const resolveProfileBound = (phaseName: string) => {
        try {
          resolveProfileForPhase(agent, 'result-writer');
        } catch {
          throw new ConfigError("unknown phase 'result-writer'");
        }
        return resolveProfileForPhase(agent, phaseName);
      };
      resolveProfileForPhaseBound = resolveProfileBound;

      const router = agentRuntime;
      if (!router) {
        throw new ConfigError('agent runtime router was not initialized');
      }
      const phaseOutputs: Record<string, string[]> = Object.fromEntries(
        Object.entries(PHASE_DEFINITIONS).map(([phaseName, definition]) => [
          phaseName,
          definition.outputs,
        ]),
      );
      artifactStoreForRun = (runUuid: string, worktreeRoot: string): ArtifactStore => {
        const runRecord = runRepository.findByUuid(runUuid);
        const durableRunId = runRecord?.displayId ?? runUuid;
        return createFilesystemArtifactStore({
          durableRoot: join(runsDir, durableRunId, 'phase-artifacts'),
          worktreeRoot,
        });
      };
      const optionalOrchestratorArtifacts = [
        'task-manifest.json',
        'validation.result',
        'validate.log',
        'validate/validation-result.json',
        'code-review.md',
        'review.md',
        'result.json',
        'follow-up-review-result.json',
        'fix-review-result.json',
        'fix-validate-result.json',
        'plan-fix-result.json',
        'compound.md',
        'pr-summary.md',
        'pr-url.txt',
      ];
      capturingAgent = createArtifactCapturingAgent({
        agent: router,
        artifactStoreForRequest: (request) => artifactStoreForRun(request.runId, request.cwd),
        phaseOutputs,
        optionalArtifacts: optionalOrchestratorArtifacts,
      });
      const artifactAgent = capturingAgent ?? router;
      let resultWriterProfile: string | undefined;
      try {
        resultWriterProfile = resolveProfileForPhase(agent, 'result-writer');
      } catch {
        // Do not throw during composeRoot so that tests lacking result-writer can construct the container.
        // The check inside resolveProfileBound will still enforce failure before any semantic agent dispatch.
      }
      const structuredResultRepair = new StructuredResultRepair({
        git: gitAdapter,
        agent: artifactAgent,
        ...(resultWriterProfile ? { repairProfile: resultWriterProfile } : {}),
      });
      phaseContextRepair = structuredResultRepair;
      const fixProfileName: string =
        config.agent.phaseProfiles['fix-review']?.profile ?? 'opencode-frontier';
      const fixFallbackProfileName: string | undefined =
        config.agent.phaseProfiles['fix-review']?.fallbackProfile;

      const newestInvocationId = (runUuid: string): string => {
        const list = agentInvocationRepository.listByRun(RunId(runUuid));
        const last = list[list.length - 1];
        return last ? String(last.id) : '';
      };
      interface RunFixResult {
        invocationId: string;
        agentOutcome: StepAgentOutcome;
        verdict?: string;
        headBeforeFix?: string;
        rebuttal?: string;
        outOfScopeReasons?: Record<string, string>;
        classification?: string;
        violationCode?: string;
        detail?: string;
      }

      const runFix = async (
        ctx: ValidateFixStepContext,
        opts: import('@ai-sdlc/application').FixStepOptions & {
          fixProfileOverride?: string;
          fixFallbackProfileOverride?: string;
          extraPromptSections?: string[];
          reconciliationContext?: string;
          attemptKind?: 'standard' | 'deterministic';
        },
      ): Promise<RunFixResult> => {
        const runDir = runRepository.findByUuid(String(ctx.runId))?.displayId ?? String(ctx.runId);
        const fallbackProfile = opts.fixFallbackProfileOverride ?? fixFallbackProfileName;
        const primaryProfile = opts.fixProfileOverride ?? fixProfileName;
        const profile = opts.useFallback && fallbackProfile ? fallbackProfile : primaryProfile;
        const promptDir = join(baseTmpDir, 'review-fix-prompts');
        mkdirSync(promptDir, { recursive: true });
        const promptPath = join(promptDir, `fix-${String(ctx.runId)}-${ctx.iterationIndex}.md`);
        const fixPrompt = buildReviewFixFixPrompt({
          cwd: ctx.cwd,
          repoId: ctx.repoId,
          useFallback: opts.useFallback,
          ...(opts.allowedFiles ? { allowedFiles: opts.allowedFiles } : {}),
          ...(opts.historyContext ? { historyContext: opts.historyContext } : {}),
          ...(opts.extraPromptSections ? { extraPromptSections: opts.extraPromptSections } : {}),
          ...(opts.deterministicDiagnostic
            ? { deterministicDiagnostic: opts.deterministicDiagnostic }
            : {}),
          ...(opts.reconciliationContext
            ? { reconciliationContext: opts.reconciliationContext }
            : {}),
        });
        writeFileSync(promptPath, fixPrompt, 'utf-8');
        const startCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: ctx.cwd,
        })
          .toString()
          .trim();
        const isDeterministic =
          opts.attemptKind === 'deterministic' || !!opts.deterministicDiagnostic;
        // Only loop-owned semantic retries carry retryIntent; deterministic
        // fixes stay tagged separately so the router never treats them as
        // semantic duplicates.
        const isSemanticRetry = ctx.iterationIndex > 1 && !opts.useFallback && !isDeterministic;
        const result = await artifactAgent.invoke({
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
                metadata: {
                  iteration: ctx.iterationIndex,
                  invocation_type: 'fallback',
                },
              }
            : {
                metadata: {
                  iteration: ctx.iterationIndex,
                  invocation_type: isDeterministic
                    ? 'deterministic_fix'
                    : isSemanticRetry
                      ? 'semantic_retry'
                      : 'initial',
                },
                ...(isDeterministic
                  ? {
                      retryIntent: {
                        normalizedPhase: 'fix-review',
                        classification: 'deterministic_gate',
                        relevantArtifactPaths: ['result.json'],
                      },
                    }
                  : isSemanticRetry
                    ? {
                        retryIntent: {
                          normalizedPhase: 'fix-review',
                          classification: 'semantic',
                          relevantArtifactPaths: ['result.json'],
                        },
                      }
                    : {}),
              }),
        });
        const invocationId = newestInvocationId(String(ctx.runId));
        const inv = agentInvocationRepository.findById(AgentInvocationId(invocationId));
        const store = artifactStoreForRun(String(ctx.runId), ctx.cwd);
        const patchedFixInv = inv?.resultJsonPath
          ? inv
          : inv
            ? { ...inv, resultJsonPath: 'result.json' }
            : inv;
        const transcriptEvidence = result.stdoutPath
          ? await readTail(result.stdoutPath)
          : undefined;
        const verdict = patchedFixInv
          ? await readFixVerdict(
              patchedFixInv,
              {
                artifacts: store,
                agent: artifactAgent,
                repair: structuredResultRepair,
              },
              { cwd: ctx.cwd, ...(transcriptEvidence ? { transcriptEvidence } : {}) },
            )
          : {
              ok: false as const,
              detail: 'no invocation row',
              classification: 'unrecoverable_artifact' as const,
              violationCode: CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT,
            };
        const shaAdvanced =
          result.endCommitSha !== undefined && result.endCommitSha !== startCommitSha;
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
        if (shaAdvanced && (!verdict.ok || verdict.verdict !== 'done_with_fixes')) {
          execFileSync('git', ['reset', '--hard', startCommitSha], {
            cwd: ctx.cwd,
          });
        }

        // The loop's verifier (verifyFixCommit, #679) is the policy owner
        // for downgrade. We pass the fixer's raw verdict through and always
        // record `headBeforeFix` so the verifier can compare HEAD before vs
        // after.
        const headBeforeFix =
          verdict.ok && verdict.verdict !== undefined ? startCommitSha : undefined;
        return {
          invocationId,
          agentOutcome: result.outcome,
          ...(verdict.ok && verdict.verdict !== undefined ? { verdict: verdict.verdict } : {}),
          ...(headBeforeFix !== undefined ? { headBeforeFix } : {}),
          ...(verdict.ok && verdict.rebuttal !== undefined ? { rebuttal: verdict.rebuttal } : {}),
          ...(verdict.ok && verdict.outOfScopeReasons !== undefined
            ? { outOfScopeReasons: verdict.outOfScopeReasons }
            : {}),
          ...(!verdict.ok
            ? {
                classification: verdict.classification,
                violationCode: verdict.violationCode,
                detail: verdict.detail,
              }
            : {}),
        };
      };

      const runRevalidation = async (ctx: ValidateFixStepContext): Promise<RevalidationResult> => {
        const runDir = runRepository.findByUuid(String(ctx.runId))?.displayId ?? String(ctx.runId);
        const revalidateLogDir = join(
          runsDir,
          runDir,
          'revalidate',
          ctx.loopId,
          String(ctx.phaseId),
          `iter-${ctx.iterationIndex}`,
        );
        let taskValidationCommands: ValidationCommand[] = [];
        const vr = await runValidation.execute({
          runId: RunId(String(ctx.runId)),
          phaseId: PhaseName('validate'),
          cwd: ctx.cwd,
          logDir: revalidateLogDir,
          commands: [...config.validation.commands, ...taskValidationCommands],
          ...(config.validation.tiers ? { tiers: config.validation.tiers } : {}),
          timeoutSeconds: config.validation.timeout,
          env: {
            GITHUB_REPOSITORY: ctx.repoId,
          },
        });
        const evalResult = await evaluateRevalidationWithInvertedCommands({
          validationRunCommands: vr.validationRun.commands,
          taskValidationCommands,
          readTail: async (path) => {
            const absPath = isAbsolute(path) ? path : join(revalidateLogDir, basename(path));
            return readTail(absPath);
          },
        });
        let failingCommands = evalResult.failingCommands;
        let revalPassed = evalResult.passed;

        if (!revalPassed && failingCommands.length > 0) {
          const manifestRaw = await artifactStoreForRun(String(ctx.runId), ctx.cwd)
            .read(String(ctx.runId), 'task-manifest.json')
            .catch(() => undefined);
          const manifest = manifestRaw ? parseTaskManifest(manifestRaw) : undefined;
          const flakeResult = await maybeRetryTransientRevalidationFlake({
            runId: String(ctx.runId),
            stepIndex: undefined,
            manifest: manifest?.success ? manifest.manifest : undefined,
            taskValidationCommands,
            failingCommands,
            revalidateLogDir,
            cwd: ctx.cwd,
            repoId: ctx.repoId,
            config,
            runValidation,
            validationAdapter,
            eventBus: persistingEventBus,
          });
          if (flakeResult.retried) {
            revalPassed = flakeResult.passed;
            failingCommands = flakeResult.failingCommands;
          }
        }
        let failureDetail: string | undefined;
        if (failingCommands.length > 0) {
          const details = await Promise.all(
            failingCommands.map(async (c) => {
              const stdoutAbs = c.stdoutPath ? join(revalidateLogDir, basename(c.stdoutPath)) : '';
              const stderrAbs = c.stderrPath ? join(revalidateLogDir, basename(c.stderrPath)) : '';
              const [stdoutTail, stderrTail] = await Promise.all([
                readTail(stdoutAbs),
                readTail(stderrAbs),
              ]);
              return `Command: ${c.command}\nOutcome: ${c.outcome}\n\nStdout:\n${stdoutTail}\n\nStderr:\n${stderrTail}`;
            }),
          );
          failureDetail = details.join('\n\n---\n\n');
        }
        const failedCommand = failingCommands[0];
        await artifactStoreForRun(String(ctx.runId), ctx.cwd).write({
          runId: String(ctx.runId),
          phaseId: 'validate',
          relativePath: 'validation.result',
          contents: revalPassed ? 'passed\n' : 'failed\n',
        });
        return {
          validationRunId: vr.validationRun.id,
          passed: revalPassed,
          ...(failedCommand?.kind ? { category: failedCommand.kind } : {}),
          ...(failedCommand?.outcome
            ? { outcome: failedCommand.outcome as ValidationCommandOutcome }
            : {}),
          ...(failureDetail ? { failureDetail } : {}),
        };
      };

      const rollbackFix = async (ctx: { cwd: string }, targetSha: string): Promise<boolean> => {
        try {
          execFileSync('git', ['reset', '--hard', targetSha], { cwd: ctx.cwd });
          return true;
        } catch {
          return false;
        }
      };

      const loopArtifactStore: ArtifactStore = {
        read: async (runId, relativePath) => {
          const run = runRepository.findByUuid(runId);
          if (!run) throw new Error(`ArtifactStore: no run found for ${runId}`);
          const repo = registryBackedRepo.findById(run.repoId);
          const repoRootPath = repo ? repo.localBasePath : targetRoot;
          const worktreePath = join(repoRootPath, '.ai-worktrees', `issue-${run.issueNumber}`);
          const cwd = existsSync(worktreePath) ? worktreePath : repoRootPath;
          return artifactStoreForRun(runId, cwd).read(runId, relativePath);
        },
        write: async (input) => {
          const run = runRepository.findByUuid(input.runId);
          if (!run) throw new Error(`ArtifactStore: no run found for ${input.runId}`);
          const repo = registryBackedRepo.findById(run.repoId);
          const repoRootPath = repo ? repo.localBasePath : targetRoot;
          const worktreePath = join(repoRootPath, '.ai-worktrees', `issue-${run.issueNumber}`);
          const cwd = existsSync(worktreePath) ? worktreePath : repoRootPath;
          return artifactStoreForRun(input.runId, cwd).write(input);
        },
        list: async (runId) => {
          const run = runRepository.findByUuid(runId);
          if (!run) throw new Error(`ArtifactStore: no run found for ${runId}`);
          const repo = registryBackedRepo.findById(run.repoId);
          const repoRootPath = repo ? repo.localBasePath : targetRoot;
          const worktreePath = join(repoRootPath, '.ai-worktrees', `issue-${run.issueNumber}`);
          const cwd = existsSync(worktreePath) ? worktreePath : repoRootPath;
          return artifactStoreForRun(runId, cwd).list(runId);
        },
        hydrateWorktree: async (runId) => {
          const run = runRepository.findByUuid(runId);
          if (!run) throw new Error(`ArtifactStore: no run found for ${runId}`);
          const repo = registryBackedRepo.findById(run.repoId);
          const repoRootPath = repo ? repo.localBasePath : targetRoot;
          const worktreePath = join(repoRootPath, '.ai-worktrees', `issue-${run.issueNumber}`);
          const cwd = existsSync(worktreePath) ? worktreePath : repoRootPath;
          return artifactStoreForRun(runId, cwd).hydrateWorktree(runId);
        },
      };

      const validateFixRunFix = async (
        ctx: import('@ai-sdlc/application').ValidateFixStepContext,
        opts: import('@ai-sdlc/application').FixStepOptions,
      ): Promise<import('@ai-sdlc/application').ValidateFixAgentResult> => {
        let failureContext: string[] = [];
        try {
          const failureContent = readFileSync(join(ctx.cwd, 'validate/failure.json'), 'utf-8');
          failureContext = [
            '',
            '## VALIDATION FAILURE CONTEXT',
            'The following validation failures were detected. Fix them:',
            '```json',
            failureContent,
            '```',
          ];
        } catch {
          // failure.json may not exist — skip
        }
        const result = await runFix(ctx, {
          ...opts,
          fixProfileOverride: fixValidateProfileName,
          ...(fixValidateFallbackProfileName
            ? { fixFallbackProfileOverride: fixValidateFallbackProfileName }
            : {}),
          extraPromptSections: failureContext,
        });
        const mappedVerdict: 'fixed' | 'cannot_fix' | 'no_fixes_needed' | undefined =
          result.verdict === 'done_with_fixes'
            ? 'fixed'
            : result.verdict === 'done_no_fixes_needed'
              ? 'no_fixes_needed'
              : result.verdict === 'cannot_fix'
                ? 'cannot_fix'
                : undefined;
        return {
          invocationId: result.invocationId,
          agentOutcome: result.agentOutcome,
          ...(mappedVerdict !== undefined ? { verdict: mappedVerdict } : {}),
          ...(result.headBeforeFix !== undefined ? { headBeforeFix: result.headBeforeFix } : {}),
        };
      };

      const fixValidateProfileName: string =
        config.agent.phaseProfiles['fix-validate']?.profile ??
        config.agent.phaseProfiles['fix-review']?.profile ??
        'opencode-frontier';
      const fixValidateFallbackProfileName: string | undefined =
        config.agent.phaseProfiles['fix-validate']?.fallbackProfile ??
        config.agent.phaseProfiles['fix-review']?.fallbackProfile;

      const validateFixLoopInstance = new ValidateFixLoop({
        runFix: validateFixRunFix,
        runRevalidation,
        rollbackFix,
        loops: loopRepository,
        events: persistingEventBus,
        git: gitAdapter,
        readWorktreeFile,
        artifactStore: loopArtifactStore,
        now: () => new Date(),
        idFactory: () => randomUUID(),
      });
      validateFixLoop = validateFixLoopInstance;

      const makeArtifactStore = (runUuid: string, cwd: string): ArtifactStore =>
        artifactStoreForRun(runUuid, cwd);

      const buildContext = (run: Run): PhaseHandlerContext => {
        const repo = registryBackedRepo.findById(run.repoId);
        const repoRootPath = repo ? repo.localBasePath : targetRoot;
        const repoFullName = repo ? repo.fullName : (resolvedRepoFullName ?? '');
        const defaultBranch = repo ? repo.defaultBranch : resolvedDefaultBranch;

        const cwd = join(repoRootPath, '.ai-worktrees', `issue-${run.issueNumber}`);
        const startCommitSha = runRepository.findByUuid(run.uuid)?.startCommitSha;
        const priorPhaseName = run.completedPhases[run.completedPhases.length - 1];
        return composeBuildPhaseHandlerContext(
          {
            runId: run.displayId,
            runUuid: run.uuid,
            repoFullName,
            issueNumber: run.issueNumber,
            cwd,
            artifacts: makeArtifactStore(run.uuid, cwd),
            github: new GhCliAdapter(),
            git: gitAdapter,
            agent: artifactAgent,
            events: persistingEventBus,
            now: () => new Date(),
          },
          {
            executionPolicy: run.executionPolicy ?? config.executionPolicy ?? 'standard',
            promptsRoot: join(effectiveRepoRoot, 'prompts'),
            expectedBranch: `ai/issue-${run.issueNumber}`,
            baseBranch: run.baseBranch ?? opts.baseBranch ?? defaultBranch,
            ...(startCommitSha ? { startCommitSha } : {}),
            ...(priorPhaseName ? { priorPhaseName } : {}),
          },
        );
      };
      buildRunContext = buildContext;

      // Wire remaining phase handlers that require agent dependencies
      phaseRegistry.register(new PlanDesignHandler());
      phaseRegistry.register(
        new ArchitectureReviewHandler({
          profileName:
            config.agent.phaseProfiles?.['architecture-review']?.profile ??
            config.agent.phaseProfiles?.['plan-design']?.profile ??
            'opencode-frontier',
          maxCorrections: config.phases.architectureReview?.maxCorrections ?? 2,
        }),
      );
      phaseRegistry.register(
        new CompoundHandler({
          exemptUndeclaredFiles: config.phases.implement.exemptUndeclaredFiles,
          scopeContractEnforcement: config.features?.scopeContractEnforcement ?? true,
        }),
      );

      const worktreeSetup = async (cwd: string): Promise<{ ok: boolean; error?: string }> => {
        try {
          execFileSync('pnpm', ['install', '--frozen-lockfile'], {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf-8',
            timeout: 120_000,
          });
        } catch (err) {
          const stderr = (err as NodeJS.ErrnoException & { stderr?: string }).stderr
            ? `\nstderr: ${(err as NodeJS.ErrnoException & { stderr?: string }).stderr}`
            : '';
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[implement setup] pnpm install failed:', msg, stderr);
          return { ok: false, error: `pnpm install failed: ${msg}${stderr}` };
        }

        // Skip build if the feature branch already has WIP commits — they will
        // have been built (and any errors surfaced) by the per-step runTypecheck
        // gate. Install still runs to guard against node_modules drift.
        let hasWip = false;
        try {
          const wipCommits = await gitAdapter.logBetween(cwd, resolvedDefaultBranch, 'HEAD');
          hasWip = wipCommits.length > 0;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[implement setup] logBetween failed; defaulting to fresh build: ${msg}`);
          hasWip = false;
        }

        if (!hasWip) {
          // --if-present: target repos without any build script (e.g. tsx-run
          // pipelines) must not fail setup on ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT.
          try {
            execFileSync('pnpm', ['-r', 'run', '--if-present', 'build'], {
              cwd,
              stdio: ['ignore', 'pipe', 'pipe'],
              encoding: 'utf-8',
              timeout: 180_000,
            });
          } catch (err) {
            const stderr = (err as NodeJS.ErrnoException & { stderr?: string }).stderr
              ? `\nstderr: ${(err as NodeJS.ErrnoException & { stderr?: string }).stderr}`
              : '';
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[implement setup] pnpm -r run --if-present build failed:', msg, stderr);
            return { ok: false, error: `pnpm -r run --if-present build failed: ${msg}${stderr}` };
          }
        }

        return { ok: true };
      };

      phaseRegistry.register(
        new ImplementHandler({
          steps: stepRepository,
          setup: worktreeSetup,
          selfVerifyCommands: config.validation.selfVerifyCommands,
        }),
      );

      phaseRegistry.register(
        new ValidateHandler({
          runValidation,
          commands: config.validation.commands,
          ...(config.validation.tiers ? { tiers: config.validation.tiers } : {}),
          timeoutSeconds: config.validation.timeout,
          logDir: join(runsDir, 'validate'),
          fixValidateEnabled: config.phases.fixValidate?.enabled !== false,
          ...(config.validation.narrowByChangedFiles !== false
            ? { discoverWorkspacePackages }
            : {}),
        }),
      );

      if (config.phases.fixValidate?.enabled !== false) {
        phaseRegistry.register(
          new FixValidateHandler({
            runLoop: async (ctx) => {
              const result = await validateFixLoopInstance.execute({
                runId: RunId(ctx.runUuid),
                phaseId: PhaseName('fix-validate'),
                repoId: ctx.repoFullName,
                cwd: ctx.cwd,
                maxIterations: config.phases.fixValidate?.maxIterations ?? 3,
                fixProfile: AgentProfileName(fixValidateProfileName),
                ...(fixValidateFallbackProfileName
                  ? { fixFallbackProfile: AgentProfileName(fixValidateFallbackProfileName) }
                  : {}),
                scopeContractEnforcement: config.features?.scopeContractEnforcement ?? true,
              });
              return {
                phaseOutcome: result.phaseOutcome,
                loopStatus: result.loop.status as 'converged' | 'failed' | 'exhausted',
              };
            },
          }),
        );
      }

      phaseRegistry.register(
        new SpecReviewHandler({
          profileName:
            (config.agent &&
              resolvePhaseProfileEntry(config.agent.phaseProfiles, 'spec-review')?.profile) ??
            'opencode-frontier',
        }),
      );

      phaseRegistry.register(
        new QualityReviewHandler({
          profileName:
            (config.agent &&
              resolvePhaseProfileEntry(config.agent.phaseProfiles, 'quality-review')?.profile) ??
            'opencode-frontier',
        }),
      );

      phaseRegistry.register(
        new FixReviewHandler({
          profileName: config.agent.phaseProfiles?.['fix-review']?.profile ?? 'opencode-frontier',
          selfVerifyCommands: config.validation.selfVerifyCommands,
        }),
      );

      phaseRegistry.register(
        new FollowUpReviewHandler({
          profileName:
            config.agent.phaseProfiles?.['follow-up-review']?.profile ?? 'opencode-frontier',
        }),
      );

      phaseRegistry.register(
        new CreatePrHandler({
          headBranch: (ctx) => `ai/issue-${ctx.issueNumber}`,
          // review-fix and compound commit after validate, so the recorded
          // validation SHA is routinely stale by the time create-pr runs.
          // Those commits are genuinely unvalidated — validate them rather
          // than blocking the run or trusting the earlier result.
          revalidate: {
            runValidation,
            commands: config.validation.commands,
            timeoutSeconds: config.validation.timeout,
            logDir: join(runsDir, 'create-pr-revalidate'),
          },
        }),
      );

      phaseRegistry.register(
        new WaitMergeHandler({
          maxPolls: config.phases.waitMerge?.maxPolls ?? 6,
          pollIntervalMs: (config.phases.waitMerge?.pollIntervalSeconds ?? 120) * 1000,
          initialDelayMs: (config.phases.waitMerge?.initialDelaySeconds ?? 600) * 1000,
        }),
      );

      runExecutor = new RunExecutor({
        runRepository,
        failureRepository,
        phaseRepository,
        events: persistingEventBus,
        registry: phaseRegistry,
        contextFactory: buildContext,
        logger,
        worktreeLifecycle: worktreeLifecycleAdapter,
        eventRepository,
        stepRepository,
        runNotification,
        reviewConvergenceMaxIterations: config.phases.reviewConvergence?.maxIterations ?? 4,
      });
    }
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    if ((err.cause as { code?: string })?.code !== 'ENOENT') throw err;
  }

  const repositoryRegistry = new RepositoryRegistryRepository(db);
  const metadataResolver = resolver;

  const listRepositories = new ListRepositories({ repos: registryReadRepo });
  const inspectRepository = new InspectRepository({ repos: registryBackedRepo });
  const registerRepository = new RegisterRepository({
    registry: repositoryRegistry,
    repos: registryReadRepo,
    metadataResolver,
  });
  const updateRepository = new UpdateRepository({
    registry: repositoryRegistry,
    repos: registryReadRepo,
  });
  const enableRepository = new EnableRepository({
    registry: repositoryRegistry,
    repos: registryReadRepo,
  });
  const disableRepository = new DisableRepository({
    registry: repositoryRegistry,
    repos: registryReadRepo,
  });
  const refreshRepository = new RefreshRepository({
    registry: repositoryRegistry,
    repos: registryReadRepo,
    metadataResolver,
  });
  const removeRepository = new RemoveRepository({
    registry: repositoryRegistry,
    repos: registryReadRepo,
  });

  const workerRegistry = new WorkerRegistryRepository(db);

  const buildWaitingRunsSweeper = () =>
    new WaitingRunsSweeper({
      sweep: new SweepWaitingRuns({
        runRepository,
        prReviewRepo: prReviewRepository,
        github: getGhAdapterForSweep(),
        eventBus: persistingEventBus,
        now: () => new Date(),
        readyMaxDays,
        runNotification,
        applyReactivation: (run: RunRecord, decision: { action: string; reason: string }) => {
          // Defer database updates only for a genuine reactivation (new review
          // activity) — Task 3's enqueued job drives that via the worker loop.
          // Merged/closed-PR finalization also arrives as action: 'reactivate'
          // but transitions the run to a terminal state (passed/cancelled)
          // and is a terminal outcome with no further worker step —
          // it must apply immediately or the finalization event is silently dropped.

          // We determine finalization by checking if decision action is 'reactivate'
          // and if decision reason indicates PR closure or merge.
          const isFinalization =
            decision.action === 'reactivate' &&
            (decision.reason.includes('PR merged') || decision.reason.includes('PR closed'));
          const isGenuineReactivation = decision.action === 'reactivate' && !isFinalization;

          if (!isGenuineReactivation) {
            applyReactivation(run as never, decision as never, {
              runRepository,
              eventBus: persistingEventBus,
              now: () => new Date(),
            });
          }
        },
        resolvePrContext: async (run: RunRecord) => resolvePrContextForRun(run),
      }),
      runRepository,
      leases: workerLeaseRepository,
      queue: jobQueue,
      eventBus: persistingEventBus,
      now: () => new Date(),
      logger: sweepLogger,
    });

  const buildOrphanedRunsSweeper = () =>
    new OrphanedRunsSweeper({
      runRepository,
      leases: workerLeaseRepository,
      queue: jobQueue,
      eventBus: persistingEventBus,
      now: () => new Date(),
      logger: sweepLogger,
    });

  const workerLoopDeps:
    | ((repoId: RepositoryId) => Omit<WorkerLoopDeps, 'recoverableRunIds'>)
    | undefined =
    runExecutor !== undefined
      ? (repoId: RepositoryId) => ({
          registry: workerRegistry,
          queue: jobQueue,
          leases: workerLeaseRepository,
          repos: registryBackedRepo,
          repoId,
          runNotification,
          executeRun: async ({ run, signal, resumeDisposition }) => {
            runRepository.update(run.uuid, { pid: process.pid });
            const controller = new AbortController();
            const onAbort = () => {
              controller.abort(signal?.reason);
            };
            if (signal) {
              if (signal.aborted) {
                controller.abort(signal.reason);
              } else {
                signal.addEventListener('abort', onAbort, { once: true });
              }
            }
            let doneResolve!: () => void;
            const donePromise = new Promise<void>((resolve) => {
              doneResolve = resolve;
            });
            abortRegistry.register(RunId(run.uuid), controller, donePromise);
            try {
              const result = await runExecutor.execute({
                run,
                skip: [],
                presentArtifacts: [],
                ...(resumeDisposition !== undefined ? { resumeDisposition } : {}),
              });
              return { ok: result.run.status === 'passed' };
            } finally {
              doneResolve();
              abortRegistry.unregister(RunId(run.uuid));
              if (signal) {
                signal.removeEventListener('abort', onAbort);
              }
            }
          },
          prepareWorktree: async ({ repoId, runId, signal: _signal }) => {
            const r = runRepository.findByUuid(runId);
            if (!r) throw new Error(`prepareWorktree: no run found for ${runId}`);
            const repo = registryBackedRepo.findById(repoId);
            const repoRootPath = repo ? repo.localBasePath : targetRoot;
            const repoDefaultBranch = repo ? repo.defaultBranch : resolvedDefaultBranch;
            const worktreePath = join(repoRootPath, '.ai-worktrees', `issue-${r.issueNumber}`);
            const baseBranch = r.baseBranch ?? opts.baseBranch ?? repoDefaultBranch;
            await gitAdapter.createWorktree({
              repoLocalBasePath: repoRootPath,
              worktreePath,
              branch: `ai/issue-${r.issueNumber}`,
              baseBranch,
            });
            if ('seedArtifactExcludes' in gitAdapter) {
              await (gitAdapter as ArtifactGuardPort).seedArtifactExcludes(worktreePath);
            }
            if (!r.startCommitSha) {
              const sha = await gitAdapter.headCommitSha(worktreePath);
              runRepository.update(r.uuid, { startCommitSha: sha });
            }
            return { cwd: worktreePath };
          },
          resetWorktree: (repoId) => {
            const lease = workerLeaseRepository.current(repoId);
            if (!lease) return;
            const r = runRepository.findByUuid(lease.runId);
            if (!r) return;
            const repo = registryBackedRepo.findById(repoId);
            const repoRootPath = repo ? repo.localBasePath : targetRoot;
            const repoDefaultBranch = repo ? repo.defaultBranch : resolvedDefaultBranch;
            const worktreePath = join(repoRootPath, '.ai-worktrees', `issue-${r.issueNumber}`);
            const baseBranch = r.baseBranch ?? opts.baseBranch ?? repoDefaultBranch;
            gitAdapter.resetWorktreeIfClean(worktreePath, baseBranch).catch(() => {});
          },
          isWorkerAlive: (workerId) => {
            const w = workerRegistry.findById(workerId, repoId);
            if (!w) return false;
            if (w.hostname !== os.hostname()) {
              // Cannot check PID on a remote host — treat stale heartbeat as dead.
              return Date.now() - w.heartbeatAt.getTime() < DEFAULT_LEASE_TTL_MS;
            }
            return checkPid(w.processId);
          },
          findRun: (runId) => runRepository.findByUuid(runId) ?? undefined,
          now: () => new Date(),
          ttlMs: DEFAULT_LEASE_TTL_MS,
          getWorktreePath: (repoId: RepositoryId) => {
            const lease = workerLeaseRepository.current(repoId);
            if (!lease) return '';
            const r = runRepository.findByUuid(lease.runId);
            if (!r) return '';
            const repo = registryBackedRepo.findById(repoId);
            const repoRootPath = repo ? repo.localBasePath : targetRoot;
            return join(repoRootPath, '.ai-worktrees', `issue-${r.issueNumber}`);
          },
          getQuarantineRoot: (repoId: RepositoryId) => {
            const repo = registryBackedRepo.findById(repoId);
            const repoRootPath = repo ? repo.localBasePath : targetRoot;
            return join(repoRootPath, '.ai-quarantine');
          },
          listRunsForRepo: (repoId: RepositoryId) => {
            const result = runRepository.list({ repositoryId: repoId });
            return result.runs as unknown as import('@ai-sdlc/domain').Run[];
          },
          updateRun: (runId, patch) => runRepository.update(String(runId), patch),
          repoAvailability: {
            markUnreachable: (repoId: RepositoryId, reason: string) => {
              repositoryRegistry.update(
                repoId,
                { healthStatus: 'unreachable', healthError: reason },
                new Date(),
              );
            },
          } as RepositoryAvailabilityPort,
        })
      : undefined;

  const resumeRun = new ResumeRun({
    runRepository,
    repos: registryBackedRepo,
    leases: workerLeaseRepository,
    queue: jobQueue,
    stepRepo: stepRepository,
    phaseRepo: phaseRepository,
    logger,
    worktreeLifecycle: worktreeLifecycleAdapter,
  });

  const retryFailedPhase = new RetryFailedPhase({
    runRepository,
    phaseRepo: phaseRepository,
    resumeRun,
  });

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
    firstReviewGraceWindowSeconds?: number;
  }): PrReviewPoller {
    if (!agentRuntime) {
      throw new ConfigError(
        'agent config required for PR review poller; configure .ai-sdlc/config.yaml',
      );
    }
    const prReviewAgent = capturingAgent ?? agentRuntime;
    if (!prReviewAgent) {
      throw new ConfigError('agent runtime router was not initialized');
    }
    const ghAdapter = new GhCliAdapter({});
    const fixDiffInspector = createFixDiffInspector();

    const processor = new ProcessPrReviewComments({
      github: ghAdapter,
      git: gitAdapter,
      agent: prReviewAgent,
      prReviewRepo: prReviewRepository,
      fixDiffInspector,
      renderTaskPrompt: async ({
        cwd,
        comment,
        diff,
        branch: _branch,
        mode,
        previousBuildError,
        previousCodeVerifyReason,
        dispositions,
      }) => {
        const promptDir = join(baseTmpDir, 'pr-review-prompt');
        mkdirSync(promptDir, { recursive: true });
        const promptPath = join(promptDir, `prompt-${comment.commentId}.md`);
        const content = buildPostPrReviewTaskPrompt({
          cwd,
          comment,
          diff,
          mode,
          ...(previousBuildError !== undefined ? { previousBuildError } : {}),
          ...(previousCodeVerifyReason !== undefined ? { previousCodeVerifyReason } : {}),
          ...(dispositions !== undefined ? { dispositions } : {}),
        });
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
              persistingEventBus.publish(runId, {
                runId,
                phase: 'post-pr-review',
                level: 'warn',
                type: 'post-pr-review.build_verification_skipped',
                message: 'build verification skipped: no validation.commands configured',
                metadata: { cwd },
                timestamp: new Date().toISOString(),
              });
            } catch {}
            return { passed: true };
          }
          const buildCheckId = `pr-review-build-check-${randomUUID()}`;
          const runRecord = runRepository.findByUuid(runId);
          const runDir = runRecord?.displayId ?? runId;
          const logDir = join(runsDir, runDir, buildCheckId);
          const repo = runRecord ? registryBackedRepo.findById(runRecord.repoId) : undefined;
          const repoFullName = repo ? repo.fullName : (resolvedRepoFullName ?? '');

          const result = await runValidation.execute({
            runId: RunId(runId),
            phaseId: PhaseName('post-pr-review'),
            cwd,
            logDir,
            logPathPrefix: buildCheckId,
            commands: config.validation.commands,
            ...(config.validation.tiers ? { tiers: config.validation.tiers } : {}),
            timeoutSeconds: config.validation.timeout,
            env: {
              GITHUB_REPOSITORY: repoFullName,
            },
          });
          if (result.passed) {
            return { passed: true };
          }
          const error = result.failure?.message || 'build failed';
          return { passed: false, error };
        } catch {
          return { passed: false, error: 'build verification threw an exception' };
        }
      },
      resolveProfileForPhase: resolveProfileForPhaseBound ?? defaultResolve,
      idFactory: () => randomUUID(),
      now: () => new Date(),
      artifactStore: {
        read: async (runId, relativePath) => {
          const run = runRepository.findByUuid(runId);
          if (!run) throw new Error(`ArtifactStore: no run found for ${runId}`);
          const repo = registryBackedRepo.findById(run.repoId);
          const repoRootPath = repo ? repo.localBasePath : targetRoot;
          const cwd = join(repoRootPath, '.ai-worktrees', `issue-${run.issueNumber}`);
          return artifactStoreForRun(runId, cwd).read(runId, relativePath);
        },
        write: async (input) => {
          const run = runRepository.findByUuid(input.runId);
          if (!run) throw new Error(`ArtifactStore: no run found for ${input.runId}`);
          const repo = registryBackedRepo.findById(run.repoId);
          const repoRootPath = repo ? repo.localBasePath : targetRoot;
          const cwd = join(repoRootPath, '.ai-worktrees', `issue-${run.issueNumber}`);
          return artifactStoreForRun(input.runId, cwd).write(input);
        },
        list: async (runId) => {
          const run = runRepository.findByUuid(runId);
          if (!run) throw new Error(`ArtifactStore: no run found for ${runId}`);
          const repo = registryBackedRepo.findById(run.repoId);
          const repoRootPath = repo ? repo.localBasePath : targetRoot;
          const cwd = join(repoRootPath, '.ai-worktrees', `issue-${run.issueNumber}`);
          return artifactStoreForRun(runId, cwd).list(runId);
        },
        hydrateWorktree: async (runId) => {
          const run = runRepository.findByUuid(runId);
          if (!run) throw new Error(`ArtifactStore: no run found for ${runId}`);
          const repo = registryBackedRepo.findById(run.repoId);
          const repoRootPath = repo ? repo.localBasePath : targetRoot;
          const cwd = join(repoRootPath, '.ai-worktrees', `issue-${run.issueNumber}`);
          return artifactStoreForRun(runId, cwd).hydrateWorktree(runId);
        },
      },
      baseBranch: opts.baseBranch ?? resolvedDefaultBranch,
      repoRoot: opts.repoRoot,
      onWarning: (message, metadata, runId) => {
        try {
          persistingEventBus.publish(runId, {
            runId,
            phase: 'post-pr-review',
            level: 'warn',
            type: 'post-pr-review.main_checkout_guard',
            message,
            metadata: metadata ?? {},
            timestamp: new Date().toISOString(),
          });
        } catch {}
      },
      rollbackFix: async ({ cwd, branch }, targetSha) => {
        try {
          execFileSync('git', ['reset', '--hard', targetSha], { cwd });
        } catch {
          return false;
        }
        try {
          execFileSync('git', ['push', '--force-with-lease', 'origin', branch], { cwd });
          return true;
        } catch {
          return false;
        }
      },
      verifyCodeChange: createVerifyCodeChange({
        agent: prReviewAgent,
        resolveProfileForPhase: resolveProfileForPhaseBound ?? defaultResolve,
        idFactory: () => randomUUID(),
        renderVerifyPrompt: async ({
          commentBody,
          path,
          line,
          cwd,
          startCommitSha,
          fixCommitSha,
        }) => {
          const promptDir = join(baseTmpDir, `verify-${fixCommitSha.slice(0, 8)}`);
          mkdirSync(promptDir, { recursive: true });
          const promptPath = join(promptDir, 'verify-prompt.md');

          // The verifier must see the FULL fix diff, not just the hunks in the
          // comment's anchored file — legitimate fixes often land in other
          // files, and a path-scoped diff renders as empty and gets rejected
          // as "no changes" (#629).
          const MAX_DIFF_CHARS = 60_000;
          let diffOutput = '';
          let scopedDiff = '';
          try {
            diffOutput = execFileSync('git', ['diff', startCommitSha, fixCommitSha], {
              cwd,
              encoding: 'utf-8',
            });
            scopedDiff = execFileSync('git', ['diff', startCommitSha, fixCommitSha, '--', path], {
              cwd,
              encoding: 'utf-8',
            });
          } catch {
            diffOutput = '(could not produce diff)';
          }
          let diffNote = '';
          if (diffOutput.trim() !== '' && scopedDiff.trim() === '') {
            diffNote =
              `Note: the fix does not modify \`${path}\` directly — it changes other files. ` +
              'Judge whether those changes address the comment.';
          }
          if (diffOutput.length > MAX_DIFF_CHARS) {
            let diffStat = '';
            try {
              diffStat = execFileSync('git', ['diff', '--stat', startCommitSha, fixCommitSha], {
                cwd,
                encoding: 'utf-8',
              });
            } catch {
              /* stat is best-effort */
            }
            // Prefer the anchored file's hunks when truncating; fall back to a
            // prefix of the full diff when the anchored file was not touched.
            const kept =
              scopedDiff.trim() !== '' ? scopedDiff : diffOutput.slice(0, MAX_DIFF_CHARS);
            diffOutput = `${kept}\n... (diff truncated; full change summary below)\n${diffStat}`;
          }

          let codeWindow = '';
          try {
            const absPath = join(cwd, path);
            const lines = readFileSync(absPath, 'utf-8').split('\n');
            const start = Math.max(0, line - 10);
            const end = Math.min(lines.length, line + 10);
            codeWindow = lines
              .slice(start, end)
              .map((l, i) => `${start + i + 1}: ${l}`)
              .join('\n');
          } catch {
            codeWindow = '(could not read file)';
          }

          const content = [
            '# Code Verification Task',
            '',
            WORKSPACE_CONSTRAINTS,
            '',
            'An automated fix was applied to address a PR review comment. Verify that the fix actually addresses the concern.',
            '',
            '## Original Review Comment',
            '',
            commentBody,
            '',
            `## File: ${path} (around line ${line})`,
            '',
            '```',
            codeWindow,
            '```',
            '',
            '## Diff Applied (full fix commit)',
            '',
            ...(diffNote !== '' ? [diffNote, ''] : []),
            '```diff',
            diffOutput,
            '```',
            '',
            '## Your Task',
            '',
            'Does the diff above actually address the review comment? Answer strictly.',
            '',
            `Write \`result.json\` to this exact path (use the absolute path as given): ${join(promptDir, 'result.json')}`,
            '```json',
            '{ "pass": true | false, "reason": "<one sentence>" }',
            '```',
          ].join('\n');

          writeFileSync(promptPath, content, 'utf-8');
          return { promptPath, resultDir: promptDir };
        },
        extractVerifyResult: async ({ resultJsonPath, resultDir }) => {
          try {
            const absPath = join(resultDir, resultJsonPath ?? 'result.json');
            const raw = readFileSync(absPath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (typeof parsed.pass === 'boolean' && typeof parsed.reason === 'string') {
              return { pass: parsed.pass, reason: parsed.reason };
            }
            return null;
          } catch {
            return null;
          }
        },
      }),
      contextSource: createPrReviewContextSource(),
      onContextSelected: (event) => {
        console.warn(
          `[post-pr-review] context_selected level=${event.level} commentIds=[${event.commentIds.join(',')}] files=[${event.includedFiles.join(',')}] fullDiffIncluded=${event.fullDiffIncluded}`,
        );
      },
      renderBatchTaskPrompt: async ({
        cwd,
        comments,
        diff: _diff,
        branch: _branch,
        mode: _mode,
        context,
        attempt,
        previousBuildError,
        previousCodeVerifyReason,
        dispositions,
      }) => {
        const promptDir = join(baseTmpDir, 'pr-review-batch-prompt');
        mkdirSync(promptDir, { recursive: true });
        const commentIdsHash = createHash('sha256')
          .update(
            comments
              .map((c) => c.commentId)
              .sort()
              .join(','),
          )
          .digest('hex')
          .slice(0, 16);
        const promptPath = join(promptDir, `batch-${commentIdsHash}.md`);
        const content = buildPostPrReviewBatchPrompt({
          cwd,
          comments,
          context,
          attempt,
          dispositions: dispositions ?? [],
          ...(previousBuildError !== undefined ? { previousBuildError } : {}),
          ...(previousCodeVerifyReason !== undefined ? { previousCodeVerifyReason } : {}),
        });
        await fsWriteFile(promptPath, content, 'utf-8');
        return promptPath;
      },
      extractBatchTaskResult: async (input) => {
        try {
          const absPath = input.resultJsonPath
            ? join(input.cwd, input.resultJsonPath)
            : join(input.cwd, 'result.json');
          const raw = readFileSync(absPath, 'utf-8');
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) {
            return { ok: false, reason: 'invalid', detail: 'expected array' };
          }
          const result = pollTaskBatchResultSchema.safeParse(parsed);
          if (!result.success) {
            return { ok: false, reason: 'invalid', detail: result.error.message };
          }
          return { ok: true, result: result.data };
        } catch (err) {
          return { ok: false, reason: 'missing', detail: String(err) };
        }
      },
    });
    return new PrReviewPoller({
      prReviewRepo: prReviewRepository,
      processOnePass: async (input) => {
        const runRecord = runRepository.findByUuid(String(input.runId));
        const perRunBase = runRecord?.baseBranch;
        if (perRunBase) {
          processor['deps'].baseBranch = perRunBase;
        }
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
            runRepository.update(record.uuid, {
              status: 'waiting',
              completedAt: readyAt,
              currentPhase: null,
            });
            const { currentPhase: _cp, ...rest } = record;
            record = { ...rest, status: 'waiting', completedAt: readyAt };
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
      firstReviewGraceWindowMs:
        (opts.firstReviewGraceWindowSeconds ?? DEFAULT_FIRST_REVIEW_GRACE_WINDOW_SECONDS) * 1000,
      maxReactivations: 100,
    });
  }

  const composeBuildPhaseHandlerContext: PhaseHandlerContextFactory = (base, opts) => {
    const idFactory = () => randomUUID();
    return {
      ...base,
      ...(resolveProfileForPhaseBound ? { resolveProfile: resolveProfileForPhaseBound } : {}),
      idFactory,
      readWorktreeFile,
      deleteWorktreeFile,
      worktreeLifecycle: worktreeLifecycleAdapter,
      eventRepository,
      repair: phaseContextRepair,
      ...(loadedSelfVerifyCommands !== undefined
        ? { selfVerifyCommands: loadedSelfVerifyCommands }
        : {}),
      ...opts,
    };
  };

  const runtimeCatalog = new DefaultRepositoryRuntimeCatalog({
    automationRoot: effectiveRepoRoot,
    stateRoot: baseTmpDir,
    controlPlaneDb: db,
    registry: registryBackedRepo,
    logger,
  });

  function buildRepositorySweepCoordinator(): RepositorySweepCoordinator {
    return {
      async execute(workerId: import('@ai-sdlc/domain').WorkerId) {
        const allOperational = await runtimeCatalog.resolveAllOperational();

        const sweepOne = async ({
          repository,
          runtime,
          error,
        }: {
          repository: import('@ai-sdlc/domain').Repository;
          runtime?: import('./repository-runtime-factory.js').RepositoryOperationalRuntime;
          error?: import('./repository-runtime-factory.js').RepositoryResolutionError;
        }): Promise<RepositorySweepResult> => {
          const entry: RepositorySweepResult = {
            repositoryId: String(repository.id),
            fullName: repository.fullName,
          };

          if (error || !runtime) {
            entry.error =
              error?.message ??
              (runtime ? 'resolution error occurred' : 'no operational runtime available');
            sweepLogger.error(
              `RepositorySweepCoordinator: cannot sweep ${repository.fullName}: ${entry.error}`,
            );
            return entry;
          }

          if (!repository.enabled) {
            entry.waiting = {
              scanned: 0,
              reactivated: 0,
              reactivatedRuns: [],
              timedOut: 0,
              passedOnMergedPr: 0,
              cancelledOnClosedPr: 0,
              stayedReady: 0,
              skipped: 0,
              errors: [],
              enqueued: 0,
              skippedLeaseConflict: 0,
              enqueueErrors: [],
            };
            sweepLogger.debug(
              `RepositorySweepCoordinator: skipping disabled repository ${repository.fullName}`,
            );
            return entry;
          }

          try {
            const resolvePrContextForRuntime = async (
              run: RunRecord,
            ): Promise<{ repoFullName: string; prNumber: number } | undefined> => {
              const artifactRoot = run.displayId ?? run.uuid;
              try {
                const prUrl = readFileSync(
                  join(runtime.paths.runsRoot(), artifactRoot, 'phase-artifacts', 'pr-url.txt'),
                  'utf8',
                ).trim();
                const match = prUrl.match(/\/pull\/(\d+)/);
                if (!match) return undefined;
                return { repoFullName: repository.fullName, prNumber: parseInt(match[1]!, 10) };
              } catch {
                return undefined;
              }
            };

            const waitingSweeper = new WaitingRunsSweeper({
              sweep: new SweepWaitingRuns({
                runRepository: runtime.runRepository,
                prReviewRepo: runtime.prReviewRepository,
                github: getGhAdapterForSweep(),
                eventBus: persistingEventBus,
                now: () => new Date(),
                readyMaxDays,
                runNotification,
                applyReactivation: (
                  run: RunRecord,
                  decision: { action: string; reason: string },
                ) => {
                  const isFinalization =
                    decision.action === 'reactivate' &&
                    (decision.reason.includes('PR merged') ||
                      decision.reason.includes('PR closed'));
                  const isGenuineReactivation = decision.action === 'reactivate' && !isFinalization;
                  if (!isGenuineReactivation) {
                    applyReactivation(run as never, decision as never, {
                      runRepository: runtime.runRepository,
                      eventBus: persistingEventBus,
                      now: () => new Date(),
                    });
                  }
                },
                resolvePrContext: resolvePrContextForRuntime,
              }),
              runRepository: runtime.runRepository,
              leases: runtime.workerLeaseRepository,
              queue: runtime.jobQueue,
              eventBus: persistingEventBus,
              now: () => new Date(),
              logger: sweepLogger,
            });

            const orphanedRunsSweeper = new OrphanedRunsSweeper({
              runRepository: runtime.runRepository,
              leases: runtime.workerLeaseRepository,
              queue: runtime.jobQueue,
              eventBus: persistingEventBus,
              now: () => new Date(),
              logger: sweepLogger,
            });

            const orphanScan = new SweepOrphanedRuns({
              runRepository: runtime.runRepository,
              phaseRepository: runtime.phaseRepository,
              isProcessAlive: checkPid,
              now: () => new Date(),
              runNotification,
              logger: sweepLogger,
            }).execute();

            entry.orphaned = await orphanedRunsSweeper.execute(orphanScan.orphanedRuns);
            entry.waiting = await waitingSweeper.execute(workerId);

            const coordinator = new RepositoryRecoveryCoordinator({
              leases: runtime.workerLeaseRepository,
              queue: runtime.jobQueue,
              registry: runtime.workerRegistry,
              repos: runtime.workerLoopDeps.repos,
              findRun: (runId) => runtime.runRepository.findByUuid(runId) ?? undefined,
              isWorkerAlive: (workerId) => {
                const w = runtime.workerRegistry.findById(workerId, repository.id);
                if (!w) return false;
                if (w.hostname !== os.hostname()) {
                  return Date.now() - w.heartbeatAt.getTime() < DEFAULT_LEASE_TTL_MS;
                }
                return checkPid(w.processId);
              },
              resetWorktree: (repoId) => {
                const lease = runtime.workerLeaseRepository.current(repoId);
                if (!lease) return;
                const r = runtime.runRepository.findByUuid(lease.runId);
                if (!r) return;
                const worktreePath = runtime.paths.worktree(r.issueNumber);
                const baseBranch = r.baseBranch ?? repository.defaultBranch;
                gitAdapter.resetWorktreeIfClean(worktreePath, baseBranch).catch(() => {});
              },
              now: () => new Date(),
              checkPid,
              registryWorkerHostname: (workerId) => {
                const w = runtime.workerRegistry.findById(workerId, repository.id);
                return w?.hostname;
              },
              getWorktreePath: (repoId) => {
                const lease = runtime.workerLeaseRepository.current(repoId);
                if (!lease) return '';
                const r = runtime.runRepository.findByUuid(lease.runId);
                if (!r) return '';
                return runtime.paths.worktree(r.issueNumber);
              },
              getQuarantineRoot: (_repoId) => {
                return join(runtime.paths.tmpRoot(), 'quarantine');
              },
              listRunsForRepo: (repoId) => {
                const result = runtime.runRepository.list({ repositoryId: repoId });
                return result.runs as unknown as import('@ai-sdlc/domain').Run[];
              },
              onOrphan: () => {
                /* Already handled by orphanedRunsSweeper above */
              },
              onWaitingReactivation: () => {
                /* Already handled by waitingSweeper above */
              },
            });

            try {
              const action = await coordinator.execute({ repoId: repository.id });
              if (action.action === 'reclaim') {
                const lease = runtime.workerLeaseRepository.current(repository.id);
                if (lease) {
                  runtime.workerLeaseRepository.release({
                    repoId: repository.id,
                    workerId: lease.workerId,
                    runId: lease.runId,
                    leaseToken: lease.leaseToken,
                  });
                }
              } else if (action.action === 'requeue') {
                const jobs = runtime.jobQueue.listForRepo(repository.id);
                for (const job of jobs) {
                  if (
                    job.status === 'claimed' &&
                    job.claimExpiresAt &&
                    job.claimExpiresAt.getTime() < Date.now()
                  ) {
                    if (job.claimedBy && job.claimToken) {
                      try {
                        runtime.jobQueue.resetToQueued(generateJobOwnership(job, job.claimedBy));
                      } catch {
                        /* ignore */
                      }
                    }
                  }
                }
              }
            } catch {
              /* recovery failure should not block sweep */
            }
          } catch (err) {
            entry.error = err instanceof Error ? err.message : String(err);
            sweepLogger.error(
              `RepositorySweepCoordinator: sweep failed for repository ${repository.fullName}: ${entry.error}`,
            );
          }

          return entry;
        };

        const settled: RepositorySweepResult[] = [];
        for (const op of allOperational) {
          settled.push(await sweepOne(op));
        }

        return { results: settled };
      },
    };
  }

  const trackedStartupSweeps: Promise<unknown>[] = [];
  if (startupSweepPromise !== undefined) {
    trackedStartupSweeps.push(startupSweepPromise);
  }

  return {
    runRepository,
    phaseRepository,
    phaseRegistry,
    executionPolicy,
    reapOrphanedTestWorkers,
    ...(runExecutor !== undefined ? { runExecutor } : {}),
    ...(runNotification !== undefined ? { runNotification } : {}),
    eventRepository,
    artifactRepository,
    failureRepository,
    agentInvocationRepository,
    validationRunRepository,
    prReviewRepository,
    loopRepository,
    workerLeaseRepository,
    jobQueue,
    workerRegistry,
    ...(workerLoopDeps !== undefined ? { workerLoopDeps } : {}),
    git: gitAdapter,
    repoFullName: resolvedRepoFullName ?? '',
    targetRepoRoot: targetRoot,
    runValidation,
    startIssueRun,
    loadRepositoryForRun,
    runAbort: abortRegistry,
    cancelRun,
    checkMergeReadiness,
    stepRepository,
    resumeRun,
    retryFailedPhase,
    runsDir,
    baseTmpDir,
    defaultBranch: resolvedDefaultBranch,
    repoDefaultBranch: resolvedDefaultBranch,
    eventBus: persistingEventBus,
    ...(agentRuntime ? { agentRuntime } : {}),
    ...(buildRunContext !== undefined ? { buildRunContext } : {}),
    resolveProfileForPhase: resolveProfileForPhaseBound ?? defaultResolve,
    buildPrReviewPoller,
    ...(validateFixLoop !== undefined ? { validateFixLoop } : {}),
    buildPhaseHandlerContext: composeBuildPhaseHandlerContext,
    createFileTailer: (opts: import('@ai-sdlc/application/ports').FileTailerOptions) =>
      new FileTailer(opts),
    repositoryRegistry,
    listRepositories,
    inspectRepository,
    registerRepository,
    updateRepository,
    enableRepository,
    disableRepository,
    refreshRepository,
    removeRepository,
    runtimeCatalog,
    serveSweepIntervalSeconds,
    schedulerConfig,
    buildWaitingRunsSweeper,
    buildOrphanedRunsSweeper,
    buildRepositorySweepCoordinator,
    get startupSweepPromise(): Promise<unknown> | undefined {
      if (trackedStartupSweeps.length === 0) return undefined;
      if (trackedStartupSweeps.length === 1) return trackedStartupSweeps[0];
      return Promise.all(trackedStartupSweeps);
    },
    set startupSweepPromise(promise: Promise<unknown> | undefined) {
      if (promise !== undefined) {
        trackedStartupSweeps.push(promise);
      }
    },
    trackStartupSweep: (promise: Promise<unknown>): void => {
      trackedStartupSweeps.push(promise);
    },
    drainStartupSweeps: async (timeoutMs?: number) => {
      if (trackedStartupSweeps.length === 0) return;
      const combined = Promise.all(trackedStartupSweeps.map((p) => p.catch(() => {})));
      if (timeoutMs !== undefined && timeoutMs > 0) {
        let timer: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        });
        try {
          await Promise.race([combined, timeoutPromise]);
        } finally {
          if (timer) {
            clearTimeout(timer);
          }
        }
      } else {
        await combined;
      }
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

export function seedTestDatabase(dbPath: string, runsDir: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  mkdirSync(runsDir, { recursive: true });

  const db = openDatabase(dbPath);
  applyMigrations(db);

  db.exec('DELETE FROM failures');
  db.exec('DELETE FROM events');
  db.exec('DELETE FROM artifacts');
  db.exec('DELETE FROM phases');
  db.exec('DELETE FROM runs');
  db.exec('DELETE FROM repositories');

  function sha256(val: string): string {
    return createHash('sha256').update(val).digest('hex');
  }

  const HEALTHY_1_ID = sha256('owner/repo-healthy-1');
  const HEALTHY_2_ID = sha256('owner/repo-healthy-2');
  const DISABLED_ID = sha256('owner/repo-disabled');
  const UNKNOWN_ID = sha256('owner/repo-unknown');
  const DEGRADED_ID = sha256('owner/repo-degraded');
  const UNREACHABLE_ID = sha256('owner/repo-unreachable');

  interface SeedRun {
    uuid: string;
    display_id: string;
    issue_number: number;
    type: string;
    status: string;
    current_phase: string | null;
    completed_phases: string;
    started_at: string;
    completed_at: string | null;
    failure_reason: string | null;
    exit_code: number | null;
    duration_ms: number | null;
    repo_id: string;
  }

  const SEED_RUNS: SeedRun[] = [
    {
      uuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      display_id: 'R-001',
      issue_number: 1,
      type: 'issue_to_pr',
      status: 'running',
      current_phase: 'implement',
      completed_phases: '[]',
      started_at: new Date().toISOString(),
      completed_at: null,
      failure_reason: null,
      exit_code: null,
      duration_ms: 5000,
      repo_id: HEALTHY_1_ID,
    },
    {
      uuid: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
      display_id: 'R-002',
      issue_number: 1,
      type: 'issue_to_pr',
      status: 'running',
      current_phase: null,
      completed_phases: '["implement"]',
      started_at: new Date().toISOString(),
      completed_at: null,
      failure_reason: null,
      exit_code: null,
      duration_ms: 10000,
      repo_id: HEALTHY_2_ID,
    },
    {
      uuid: 'c3d4e5f6-a7b8-9012-cdef-123456789012',
      display_id: 'R-003',
      issue_number: 3,
      type: 'issue_to_pr',
      status: 'failed',
      current_phase: null,
      completed_phases: '["implement"]',
      started_at: new Date(Date.now() - 120_000).toISOString(),
      completed_at: new Date().toISOString(),
      failure_reason: null,
      exit_code: 1,
      duration_ms: 30000,
      repo_id: HEALTHY_1_ID,
    },
  ];

  const extraUuids = Array.from({ length: 27 }, () => randomUUID());
  for (let i = 4; i <= 30; i++) {
    const displayId = `R-${i.toString().padStart(3, '0')}`;
    const isLast = i === 30;
    SEED_RUNS.push({
      uuid: extraUuids[i - 4]!,
      display_id: displayId,
      issue_number: i,
      type: 'issue_to_pr',
      status: 'passed',
      current_phase: null,
      completed_phases: '["implement","verify"]',
      started_at: new Date(Date.now() - i * 60_000).toISOString(),
      completed_at: new Date().toISOString(),
      failure_reason: null,
      exit_code: 0,
      duration_ms: 5000,
      repo_id: isLast ? 'unregistered-repo-id' : HEALTHY_1_ID,
    });
  }

  const insertRepo = db.prepare(`
    INSERT INTO repositories (
      id, full_name, owner, name, local_base_path, default_branch, remote_url,
      enabled, health_status, health_error, last_health_check_at, created_at, updated_at
    ) VALUES (
      @id, @full_name, @owner, @name, @local_base_path, @default_branch, @remote_url,
      @enabled, @health_status, @health_error, @last_health_check_at, @created_at, @updated_at
    )
  `);

  const reposData = [
    {
      id: HEALTHY_1_ID,
      full_name: 'owner/repo-healthy-1',
      owner: 'owner',
      name: 'repo-healthy-1',
      local_base_path: '/path/to/repo-healthy-1',
      default_branch: 'main',
      remote_url: 'git@github.com:owner/repo-healthy-1.git',
      enabled: 1,
      health_status: 'healthy',
      health_error: null,
      last_health_check_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: HEALTHY_2_ID,
      full_name: 'owner/repo-healthy-2',
      owner: 'owner',
      name: 'repo-healthy-2',
      local_base_path: '/path/to/repo-healthy-2',
      default_branch: 'main',
      remote_url: 'git@github.com:owner/repo-healthy-2.git',
      enabled: 1,
      health_status: 'healthy',
      health_error: null,
      last_health_check_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: DISABLED_ID,
      full_name: 'owner/repo-disabled',
      owner: 'owner',
      name: 'repo-disabled',
      local_base_path: '/path/to/repo-disabled',
      default_branch: 'main',
      remote_url: 'git@github.com:owner/repo-disabled.git',
      enabled: 0,
      health_status: 'healthy',
      health_error: null,
      last_health_check_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: UNKNOWN_ID,
      full_name: 'owner/repo-unknown',
      owner: 'owner',
      name: 'repo-unknown',
      local_base_path: '/path/to/repo-unknown',
      default_branch: 'main',
      remote_url: 'git@github.com:owner/repo-unknown.git',
      enabled: 1,
      health_status: 'unknown',
      health_error: null,
      last_health_check_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: DEGRADED_ID,
      full_name: 'owner/repo-degraded',
      owner: 'owner',
      name: 'repo-degraded',
      local_base_path: '/path/to/repo-degraded',
      default_branch: 'main',
      remote_url: 'git@github.com:owner/repo-degraded.git',
      enabled: 1,
      health_status: 'degraded',
      health_error: 'health check failed',
      last_health_check_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: UNREACHABLE_ID,
      full_name: 'owner/repo-unreachable',
      owner: 'owner',
      name: 'repo-unreachable',
      local_base_path: '/path/to/repo-unreachable',
      default_branch: 'main',
      remote_url: 'git@github.com:owner/repo-unreachable.git',
      enabled: 1,
      health_status: 'unreachable',
      health_error: 'unreachable',
      last_health_check_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  for (const r of reposData) {
    insertRepo.run(r);
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO runs (uuid, display_id, issue_number, type, status, current_phase,
      completed_phases, started_at, completed_at, failure_reason, exit_code, duration_ms, repo_id)
    VALUES (@uuid, @display_id, @issue_number, @type, @status, @current_phase,
      @completed_phases, @started_at, @completed_at, @failure_reason, @exit_code, @duration_ms, @repo_id)
  `);

  const insertFailure = db.prepare(`
    INSERT OR REPLACE INTO failures (run_uuid, phase, step, attempt, kind, message, exit_code,
      can_retry, suggested_action, artifacts, detected_at)
    VALUES (@run_uuid, @phase, @step, @attempt, @kind, @message, @exit_code,
      @can_retry, @suggested_action, @artifacts, @detected_at)
  `);

  for (const run of SEED_RUNS) {
    insert.run(run);

    const runDir = join(runsDir, run.display_id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'combined.log'), 'seeded log content\n');
  }

  const r3Dir = join(runsDir, 'R-003');
  writeFileSync(join(r3Dir, 'output.json'), JSON.stringify({ key: 'value', count: 42 }));
  writeFileSync(join(r3Dir, 'README.md'), '# Hello\n\nThis is **bold** markdown.');
  writeFileSync(join(r3Dir, 'data.json'), JSON.stringify({ key: 'value', count: 42 }));

  insertFailure.run({
    run_uuid: SEED_RUNS[2]!.uuid,
    phase: 'implement',
    step: null,
    attempt: 1,
    kind: 'command_failed',
    message: 'something went wrong',
    exit_code: 1,
    can_retry: 0,
    suggested_action: 'fix the test',
    artifacts: JSON.stringify(['test.log']),
    detected_at: new Date().toISOString(),
  });

  const insertEvent = db.prepare(`
    INSERT INTO events (run_uuid, phase, level, type, message, metadata, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date();
  const ts = (offsetMs: number) => new Date(now.getTime() - offsetMs).toISOString();

  const r001 = SEED_RUNS[0]!.uuid;
  insertEvent.run(r001, 'read_issue', 'info', 'phase.started', '', '{}', ts(120_000));
  insertEvent.run(r001, 'read_issue', 'info', 'phase.completed', '', '{}', ts(115_000));
  insertEvent.run(r001, 'plan-design', 'info', 'phase.started', '', '{}', ts(115_000));
  insertEvent.run(r001, 'plan-design', 'info', 'phase.completed', '', '{}', ts(110_000));
  insertEvent.run(r001, 'plan-write', 'info', 'phase.started', '', '{}', ts(110_000));
  insertEvent.run(r001, 'plan-write', 'info', 'phase.completed', '', '{}', ts(100_000));
  insertEvent.run(r001, 'implement', 'info', 'phase.started', '', '{}', ts(100_000));

  const r003 = SEED_RUNS[2]!.uuid;
  insertEvent.run(r003, 'read_issue', 'info', 'phase.started', '', '{}', ts(180_000));
  insertEvent.run(r003, 'read_issue', 'info', 'phase.completed', '', '{}', ts(175_000));
  insertEvent.run(r003, 'plan-design', 'info', 'phase.started', '', '{}', ts(175_000));
  insertEvent.run(r003, 'plan-design', 'info', 'phase.completed', '', '{}', ts(170_000));
  insertEvent.run(r003, 'plan-write', 'info', 'phase.started', '', '{}', ts(170_000));
  insertEvent.run(r003, 'plan-write', 'info', 'phase.completed', '', '{}', ts(160_000));
  insertEvent.run(r003, 'implement', 'info', 'phase.started', '', '{}', ts(160_000));
  insertEvent.run(r003, 'implement', 'info', 'phase.completed', '', '{}', ts(150_000));
  insertEvent.run(r003, 'validate', 'info', 'phase.started', '', '{}', ts(150_000));
  insertEvent.run(
    r003,
    'validate',
    'error',
    'phase.failed',
    'something went wrong',
    '{"command":"pnpm build","exitCode":1}',
    ts(140_000),
  );

  db.close();
}

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
  createFilesystemArtifactStore,
} from '@ai-sdlc/infrastructure';
import {
  StartIssueRun,
  CancelRun,
  ResumeRun,
  RetryFailedPhase,
  SweepOrphanedRuns,
  checkPid,
  RunValidation,
  ReadIssueHandler,
  PlanDesignHandler,
  PlanWriteHandler,
  ImplementHandler,
  ValidateHandler,
  ReviewFixHandler,
  CompoundHandler,
  CreatePrHandler,
  PostPrReviewHandler,
  PrReviewPoller,
  ProcessPrReviewComments,
  decideReactivation,
  applyReactivation,
  createVerifyCodeChange,
  pollTaskResultSchema,
  ReviewFixLoop,
  ValidateFixLoop,
  FixValidateHandler,
  ImplementStepLoop,
  readReviewVerdict,
  readFixVerdict,
  PhaseHandlerRegistry,
  RunExecutor,
  type WorkerLoopDeps,
  ArtifactNotFoundError,
  type ArtifactStore,
  type StartIssueRunDeps,
  type ClassifyExitFn,
  type EventTailerFactory,
  type EventBusPort,
  type RunRepositoryPort,
  type TmpDirectoryFactory,
  type StepContext,
  type RepositoryPort,
  type JobQueuePort,
  type StepRepositoryPort,
  type ReviewStepResult,
  type FixStepResult,
  type GitPort,
  type ArtifactGuardPort,
  type RevalidationResult,
  type PostFixGateResult,
  type ReviewStepOptions,
  type PhaseHandlerContext,
  type PhaseHandlerContextFactory,
  type ImplementStepLoop as ImplementStepLoopType,
  type StepLoopContext,
  type FixStepOptions,
  type ImplementStepOptions,
  type TypecheckResult,
  type TypescriptError,
  type ResolveRefShaFn,
  extractTaskBody,
  parseTaskManifest,
  parseTypescriptErrors,
  renderStructuredTypecheckErrors,
  type TaskManifest,
  PHASE_DEFINITIONS,
} from '@ai-sdlc/application';
import { ConfigError, loadConfig, PHASE_FALLBACKS, type AgentConfig } from '@ai-sdlc/shared';
import {
  AgentProfileName,
  AgentInvocationId,
  PhaseName,
  Repository,
  Run,
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
import { createArtifactCapturingAgent } from './durable-agent-artifacts.js';
import { buildLintTaskSize } from './lint-task-size.js';
import { buildReviewFixReviewPrompt, buildReviewFixFixPrompt } from './review-fix-prompts.js';
import { createReviewLoopHistoryFilePort } from './review-loop-history-file-port.js';

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

export function buildImplementPrompt(
  ctx: { stepIndex: number; stepTitle: string; cwd: string; repoId: string },
  taskText: string,
  branchName: string,
  typecheckErrors?: TypescriptError[] | string,
): string {
  const taskN = ctx.stepIndex;
  const taskTitle = ctx.stepTitle;
  const description = taskText || `See plan.md Task ${taskN} for details.`;

  const structuredErrors: TypescriptError[] | undefined =
    typeof typecheckErrors === 'string' ? parseTypescriptErrors(typecheckErrors) : typecheckErrors;

  return [
    `You are implementing Task ${taskN}: ${taskTitle}`,
    '',
    '## Task Description',
    description,
    '',
    '## Context',
    `You are working in: ${ctx.cwd}`,
    `Repository: ${ctx.repoId}`,
    'Issue: issue.md',
    'Design: design.md',
    'Plan: plan.md',
    `Branch: ${branchName}`,
    '',
    'You are using Subagent-Driven Development. Follow the process below exactly.',
    '',
    '## SCOPE RESTRICTION',
    `You are implementing ONLY Task ${taskN}: ${taskTitle}.`,
    '',
    `Tasks numbered higher than ${taskN} in plan.md are EXPLICITLY OUT OF SCOPE`,
    'for this run. They will be implemented by separate later runs of this',
    'orchestrator. You must NOT:',
    '- create files, types, schemas, tests, exports, or migrations that belong',
    '  to a later task, even if you have all the context to do so;',
    "- 'finish the plan' because tasks N+1..M look small or related;",
    "- pre-stage scaffolding for later tasks 'to save time later'.",
    '',
    'A commit that includes any later-task work is a scope violation, not',
    'helpfulness — it breaks per-task review, makes resume undecidable, and',
    "forces the operator to revert and re-run. The plan's per-task commit",
    'boundary is load-bearing: respect it.',
    '',
    `If you finish Task ${taskN} quickly: STOP, run the self-review, and`,
    "report DONE. Do not 'continue' into the next task.",
    '',
    'You may READ files associated with later tasks for context, but you must',
    'not write, modify, stage, or commit them in this run.',
    '',
    ...(structuredErrors !== undefined && structuredErrors.length > 0
      ? renderStructuredTypecheckErrors(structuredErrors)
      : typeof typecheckErrors === 'string' && typecheckErrors.length > 0
        ? [
            '## Typecheck Errors From Previous Attempt (unparsed output)',
            '',
            'Fix ALL of the following errors before committing — do not skip any:',
            '',
            '```',
            typecheckErrors,
            '```',
            '',
          ]
        : []),
    '## Your Job',
    '',
    `1. Read issue.md, design.md, and plan.md for context. Identify the`,
    `   boundaries of Task ${taskN} specifically.`,
    `2. Implement exactly what Task ${taskN} specifies — nothing more.`,
    `3. Write tests following TDD where applicable, scoped to Task ${taskN}.`,
    `4. Verify Task ${taskN}'s implementation works.`,
    '5. Commit your work:',
    '   a. Record HEAD before: PRE_HEAD=$(git rev-parse HEAD)',
    "   b. Run: git add <files> && git commit -m '<descriptive commit message>'",
    '   c. Verify the commit landed:',
    '      - If git commit exits non-zero, the pre-commit hook failed. Read the',
    '        hook/lint output, FIX the reported errors, and retry the commit.',
    '        Never report DONE with a failed or skipped commit.',
    '      - After a successful commit, confirm HEAD advanced:',
    '        [ "$(git rev-parse HEAD)" != "$PRE_HEAD" ] || { echo "COMMIT DID NOT ADVANCE"; exit 1; }',
    '      - Confirm clean worktree:',
    '        [ -z "$(git status --porcelain)" ] || { echo "WORKTREE DIRTY AFTER COMMIT"; exit 1; }',
    '   d. HARD RULE: Never infer commit success from git log. Git log shows',
    "      OTHER tasks' commits. Only git rev-parse HEAD + git status --porcelain",
    '      prove YOUR commit landed.',
    "   e. If you cannot get the commit to land (hook failure you can't fix),",
    '      report BLOCKED with the hook output — never DONE.',
    `6. Self-review before reporting back, including the scope check below.`,
    '',
    '## Questions?',
    'If you have clarifications or concerns BEFORE implementing, note them in your report',
    'and proceed with a reasonable assumption. Do not ask questions — make decisions',
    'and document them.',
    '',
    '## Self-Review Checklist (before reporting back)',
    `- Scope: Run \`git diff --stat HEAD~1\` mentally — does every changed`,
    `  file belong to Task ${taskN} alone? If any file is for a later task,`,
    '  REMOVE it from the commit before reporting DONE.',
    '- Commit integrity: Did I verify HEAD advanced after my commit? Is',
    '  git status --porcelain empty? (See step 5c/d.)',
    `- Completeness: Did I implement everything Task ${taskN} specifies?`,
    '- Quality: Is the code clean and maintainable?',
    '- Discipline: Did I avoid overbuilding?',
    '- Testing: Do tests verify actual behavior?',
    '',
    '## Report Format',
    'Report back with:',
    '- Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT',
    '- What you implemented',
    '- What you tested and results',
    '- Files changed',
    '- Self-review findings',
    '- Any questions or concerns',
    '',
    '## Branch Restriction',
    `CRITICAL: Do NOT switch branches (no git checkout, git switch, git stash branch). All work must stay on branch ${branchName}.`,
    '',
    'Write a summary to implementation-log.md.',
  ].join('\n');
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
  runExecutor?: RunExecutor;
  eventRepository: EventRepository;
  artifactRepository: ArtifactRepository;
  failureRepository: FailureRepository;
  agentInvocationRepository: AgentInvocationRepository;
  validationRunRepository: ValidationRunRepository;
  prReviewRepository: PrReviewRepository;
  loopRepository: LoopRepository;
  workerLeaseRepository: WorkerLeaseRepository;
  jobQueue: JobQueuePort;
  workerRegistry?: WorkerRegistryRepository;
  workerLoopDeps?: Omit<WorkerLoopDeps, 'recoverableRunIds'>;
  /** Exposed for worktree lifecycle management in CLI and tests. */
  git: GitPort;
  /** Context factory for a full run (includes promptsRoot, expectedBranch, cwd). Only present when agent config is loaded. */
  buildRunContext?: (run: Run) => PhaseHandlerContext;
  repoFullName?: string;
  runValidation: RunValidation;
  startIssueRun: StartIssueRun;
  cancelRun: CancelRun;
  stepRepository: StepRepositoryPort;
  resumeRun: {
    execute(input: {
      runId: RunId;
      fromPhase?: string;
      workerId: import('@ai-sdlc/domain').WorkerId;
      attempt?: number;
    }): Promise<void>;
    transition(input: {
      runId: RunId;
      fromPhase?: string;
      workerId: import('@ai-sdlc/domain').WorkerId;
      attempt?: number;
    }): ReturnType<ResumeRun['transition']>;
  };
  retryFailedPhase: RetryFailedPhase;
  runsDir: string;
  baseTmpDir: string;
  defaultBranch: string;
  eventBus: EventBusPort;
  /** @deprecated Use `resolveProfileForPhase()` instead */
  agentRuntime?: AgentRuntimeRouter;
  resolveProfileForPhase: (phaseName: string) => AgentProfileName;
  buildPhaseHandlerContext: PhaseHandlerContextFactory;
  reviewFixLoop?: ReviewFixLoop;
  validateFixLoop?: ValidateFixLoop;
  implementStepLoop?: ImplementStepLoopType;
  runStep?: (sctx: {
    stepIndex: number;
    stepTitle: string;
    cwd: string;
    ctx: import('@ai-sdlc/application').PhaseHandlerContext;
  }) => Promise<{ outcome: 'success' | 'failed' | 'needs_human_review' }>;
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
  /** Inject repo full name (for tests; skips gh CLI resolution) */
  repoFullName?: string;
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

class SingleRepoAdapter implements RepositoryPort {
  constructor(private readonly repo: Repository) {}

  findById(id: RepositoryId): Repository | undefined {
    return this.repo.id === id ? this.repo : undefined;
  }

  findByFullName(fullName: string): Repository | undefined {
    return this.repo.fullName === fullName ? this.repo : undefined;
  }

  listEnabled(): Repository[] {
    return this.repo.enabled ? [this.repo] : [];
  }
}

export function buildSpecReviewPrompt(
  ctx: { stepIndex: number; stepTitle: string; cwd: string },
  typecheckSection: string,
  implReport = '',
): string {
  const reportExcerpt = implReport.split('\n').slice(0, 50).join('\n');
  return [
    '# TASK',
    `Review implementation of step ${ctx.stepIndex}: ${ctx.stepTitle}`,
    '',
    'Check that the implementation matches plan.md task requirements exactly.',
    '',
    '## HARD CONSTRAINT — READ-ONLY REVIEW',
    'You MUST NOT execute any shell commands, run tests, run builds, or invoke any',
    'tools that modify the filesystem or execute code. Review by reading files only:',
    'plan.md, implementation-log.md, git diff output, and changed source files.',
    'If the task was verification-only (no files changed), check the implementer report',
    'below to confirm all required verifications passed, then write result.json with',
    '"pass". Do not re-run the verifications yourself.',
    '',
    '## CRITICAL: Do Not Trust the Report Alone',
    'The implementer report below is what the agent claims it built. You MUST read the',
    "actual committed code and verify line by line. Do not take the implementer's word.",
    '',
    '## What the Implementer Claims',
    reportExcerpt,
    '',
    '## CONTEXT',
    `Working directory: ${ctx.cwd}`,
    '',
    typecheckSection,
    '',
    '## OUTPUT',
    `Write ${ctx.cwd}/result.json: { "result": "pass" | "fail" }`,
    'Do NOT write to a relative path — use the full absolute path above.',
    '',
    '## STOP RULE — THIS IS THE MOST IMPORTANT RULE',
    'After writing result.json you are DONE. Do NOT:',
    '- Re-read any files',
    '- Re-verify your work',
    '- Run any commands',
    '- Start the review over',
    '- Do anything at all',
    'Any action after writing result.json is a contract violation.',
  ].join('\n');
}

export function buildQualityReviewPrompt(
  ctx: { stepIndex: number; stepTitle: string; cwd: string },
  typecheckSection: string,
): string {
  return [
    '# TASK',
    `Review implementation quality for step ${ctx.stepIndex}: ${ctx.stepTitle}`,
    '',
    'Check for code quality: maintainability, performance, security, test coverage.',
    '',
    '## HARD CONSTRAINT — READ-ONLY REVIEW',
    'You MUST NOT execute any shell commands, run tests, run builds, or invoke any',
    'tools that modify the filesystem or execute code. Review by reading files only.',
    'If the task was verification-only (no files changed), write result.json with',
    '"pass" — quality review does not apply to verification-only steps.',
    '',
    '## CONTEXT',
    `Working directory: ${ctx.cwd}`,
    '',
    typecheckSection,
    '',
    '## OUTPUT',
    `Write ${ctx.cwd}/result.json: { "result": "pass" | "fail" }`,
    'Do NOT write to a relative path — use the full absolute path above.',
  ].join('\n');
}

export interface BuildPostPrReviewTaskPromptInput {
  cwd: string;
  comment: {
    commentId: number;
    path: string;
    line: number;
    body: string;
  };
  diff: string;
  previousBuildError?: string;
  previousCodeVerifyReason?: string;
}

export function buildPostPrReviewTaskPrompt(input: BuildPostPrReviewTaskPromptInput): string {
  const { cwd, comment, diff, previousBuildError, previousCodeVerifyReason } = input;
  const sections = [
    '# PR Review Comment Task',
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

  sections.push(
    '## Instructions',
    '',
    'Make a judgement call: is this comment technically valid?',
    '',
    'If a code change is required:',
    '1. Edit the relevant source files',
    '2. Commit your change:',
    '   a. Record HEAD before: `PRE_HEAD=$(git rev-parse HEAD)`',
    '   b. Stage and commit: `git add -A && git commit -m "fix: address PR review feedback"`',
    '   c. If git commit exits non-zero, the pre-commit hook failed. Read the hook/lint',
    '      output, FIX the reported errors, and retry the commit. Never report action=fixed',
    '      with a failed or skipped commit.',
    '   d. After a successful commit, confirm HEAD advanced:',
    '      `[ "$(git rev-parse HEAD)" != "$PRE_HEAD" ] || { echo "COMMIT DID NOT ADVANCE HEAD"; exit 1; }`',
    '   e. Confirm clean worktree:',
    '      `[ -z "$(git status --porcelain)" ] || { echo "WORKTREE DIRTY AFTER COMMIT"; exit 1; }`',
    '   f. Only write action=fixed in result.json after steps d and e both pass.',
    '3. Do NOT push. The orchestrator will push only after validation passes.',
    '',
    'If the comment is invalid, include your reasoning in replyBody.',
    '',
    'IMPORTANT: Do NOT post replies yourself. The orchestrator handles posting.',
    'IMPORTANT: Do NOT push to any remote branch.',
    '',
    '---',
    '',
    '**CRITICAL: Do NOT run any of the following commands.**',
    '- Do NOT run npm/pnpm/yarn/bun build, test, lint, typecheck, depcruise, or test:bash',
    '- Do NOT run any shell scripts that invoke tests or linters',
    '- Do NOT run npm/pnpm/yarn/bun install or any package manager commands',
    '- Do NOT verify your fix - the orchestrator handles all verification deterministically',
    '',
    'Your ONLY responsibility is: read the comment, make a code change (if needed), commit the change locally (verifying HEAD advanced), write result.json, and stop immediately.',
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
  const workerLeaseRepository = new WorkerLeaseRepository(db);
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
  const gitAdapter = new GitWorktreeAdapter();

  const cancelRun = new CancelRun({
    runRepository,
    logger,
    runAbort: abortRegistry,
    git: gitAdapter,
    leases: workerLeaseRepository,
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
  if (opts.repoFullName) {
    resolvedRepoFullName = opts.repoFullName;
  } else if (process.env.GITHUB_REPOSITORY) {
    resolvedRepoFullName = process.env.GITHUB_REPOSITORY;
  } else {
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
  }

  let agentRuntime: AgentRuntimeRouter | undefined;
  let capturingAgent: import('@ai-sdlc/application').AgentPort | undefined;
  let resolveProfileForPhaseBound: ((phaseName: string) => AgentProfileName) | undefined;
  let reviewFixLoop: ReviewFixLoop | undefined;
  let validateFixLoop: ValidateFixLoop | undefined;
  let implementStepLoop: ImplementStepLoopType | undefined;
  let runStep: Container['runStep'] | undefined;
  let runExecutor: RunExecutor | undefined;
  let buildRunContext: ((run: Run) => PhaseHandlerContext) | undefined;
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
      // Non-optional local so the ReviewFixHandler closure below can reference it
      // without a guard (the outer `let` stays `| undefined` for other consumers).
      const resolveProfileBound = (phaseName: string) => resolveProfileForPhase(agent, phaseName);
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
      const optionalOrchestratorArtifacts = [
        'task-manifest.json',
        'validation.result',
        'validate.log',
        'validate/validation-result.json',
        'code-review.md',
        'review.md',
        'result.json',
        'compound.md',
        'pr-summary.md',
        'pr-url.txt',
      ];
      const artifactStoreForRun = (runUuid: string, worktreeRoot: string): ArtifactStore => {
        const runRecord = runRepository.findByUuid(runUuid);
        const durableRunId = runRecord?.displayId ?? runUuid;
        return createFilesystemArtifactStore({
          durableRoot: join(runsDir, durableRunId, 'phase-artifacts'),
          worktreeRoot,
        });
      };
      capturingAgent = createArtifactCapturingAgent({
        agent: router,
        artifactStoreForRequest: (request) => artifactStoreForRun(request.runId, request.cwd),
        phaseOutputs,
        optionalArtifacts: optionalOrchestratorArtifacts,
      });
      const artifactAgent = capturingAgent ?? router;
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

      const runReview = async (
        ctx: StepContext,
        opts?: ReviewStepOptions | PostFixGateResult,
      ): Promise<ReviewStepResult> => {
        const gateResult: PostFixGateResult | undefined =
          opts && 'outcome' in opts ? opts : opts?.gateResult;
        const historyContext: string | undefined =
          opts && 'historyContext' in opts ? opts.historyContext : undefined;
        const runDir = runRepository.findByUuid(String(ctx.runId))?.displayId ?? String(ctx.runId);
        const promptDir = join(baseTmpDir, 'review-fix-prompts');
        mkdirSync(promptDir, { recursive: true });
        const promptPath = join(promptDir, `review-${String(ctx.runId)}-${ctx.iterationIndex}.md`);

        const reviewPrompt = buildReviewFixReviewPrompt({
          cwd: ctx.cwd,
          repoId: ctx.repoId,
          defaultBranch: resolvedDefaultBranch,
          gateFailureOutput: gateResult?.outcome === 'fail' ? gateResult.output : undefined,
          historyContext,
        });
        writeFileSync(promptPath, reviewPrompt, 'utf-8');
        const startCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: ctx.cwd,
        })
          .toString()
          .trim();
        const result = await artifactAgent.invoke({
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
        const store = artifactStoreForRun(String(ctx.runId), ctx.cwd);
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
              { artifacts: store, agent: artifactAgent },
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
          fixProfileOverride?: string;
          fixFallbackProfileOverride?: string;
          extraPromptSections?: string[];
          historyContext?: string;
        },
      ): Promise<FixStepResult> => {
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
          historyContext: opts.historyContext,
          architectPlan: opts.architectPlan,
          useFallback: opts.useFallback,
          extraPromptSections: opts.extraPromptSections,
        });
        writeFileSync(promptPath, fixPrompt, 'utf-8');
        const startCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: ctx.cwd,
        })
          .toString()
          .trim();
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
              }
            : {}),
        });
        const invocationId = newestInvocationId(String(ctx.runId));
        const inv = agentInvocationRepository.findById(AgentInvocationId(invocationId));
        const store = artifactStoreForRun(String(ctx.runId), ctx.cwd);
        const patchedFixInv = inv?.resultJsonPath
          ? inv
          : inv
            ? { ...inv, resultJsonPath: 'result.json' }
            : inv;
        const verdict = patchedFixInv
          ? await readFixVerdict(patchedFixInv, { artifacts: store, agent: artifactAgent })
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
        if (vr.passed) {
          await artifactStoreForRun(String(ctx.runId), ctx.cwd).write({
            runId: String(ctx.runId),
            phaseId: 'validate',
            relativePath: 'validation.result',
            contents: 'passed\n',
          });
        }
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

      const loopHistory = createReviewLoopHistoryFilePort(persistingEventBusForLoop);

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

      const rollbackFix = async (ctx: StepContext, targetSha: string): Promise<boolean> => {
        try {
          execFileSync('git', ['reset', '--hard', targetSha], { cwd: ctx.cwd });
          return true;
        } catch {
          return false;
        }
      };

      const runPostFixGate = async (ctx: StepContext): Promise<PostFixGateResult> => {
        const outputs: string[] = [];
        let buildError = '';
        // Pre-build: refresh .d.ts files before typecheck. Non-fatal — let
        // the typecheck surface precise errors if the build actually broke.
        try {
          execFileSync('pnpm', ['-r', 'build'], {
            cwd: ctx.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf-8',
            timeout: 180_000,
          });
        } catch (err) {
          buildError = captureExecOutput(err);
          // Non-fatal
        }
        const execOrSkip = (command: string, args: string[]): void => {
          try {
            execFileSync(command, args, {
              cwd: ctx.cwd,
              stdio: ['ignore', 'pipe', 'pipe'],
              encoding: 'utf-8',
            });
          } catch (err) {
            if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
              return;
            }
            outputs.push(captureExecOutput(err));
          }
        };
        execOrSkip('pnpm', ['-r', 'typecheck']);
        execOrSkip('pnpm', ['lint']);
        if (buildError) {
          outputs.push(buildError);
        }
        if (outputs.length === 0) {
          return { outcome: 'pass', output: '' };
        }
        const combined = outputs.join('\n---\n');
        const lines = combined.split('\n');
        const lineLimited = lines.length > 100 ? lines.slice(0, 100).join('\n') : combined;
        const trimmed = lineLimited.slice(0, 3000);
        const lastNewline = trimmed.lastIndexOf('\n');
        if (trimmed.length < lineLimited.length && lastNewline > 0) {
          return { outcome: 'fail', output: trimmed.slice(0, lastNewline) };
        }
        return { outcome: 'fail', output: trimmed };
      };

      // Non-optional local so the ReviewFixHandler closure below can reference it
      // without a guard (the outer `let` stays `| undefined` for other consumers).
      const reviewFixLoopInstance = new ReviewFixLoop({
        runPostFixGate,
        runReview,
        runFix,
        runRevalidation,
        rollbackFix,
        loops: loopRepository,
        events: persistingEventBusForLoop,
        loopHistory,
        now: () => new Date(),
        idFactory: () => randomUUID(),
        cleanArtifacts: async (ctx) => {
          if (typeof gitAdapter.cleanOrchestratorArtifacts === 'function') {
            const artifacts = artifactStoreForRun(String(ctx.runId), ctx.cwd);
            let savedValidationResult: string | undefined;
            try {
              savedValidationResult = await artifacts.read(String(ctx.runId), 'validation.result');
            } catch {
              // not present — nothing to restore
            }
            await gitAdapter.cleanOrchestratorArtifacts(
              ctx.cwd,
              opts.baseBranch ?? resolvedDefaultBranch,
            );
            if (savedValidationResult !== undefined && savedValidationResult.trim() !== '') {
              await artifacts.write({
                runId: String(ctx.runId),
                phaseId: 'validate',
                relativePath: 'validation.result',
                contents: savedValidationResult,
              });
            }
          }
        },
      });
      reviewFixLoop = reviewFixLoopInstance;

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
        events: persistingEventBusForLoop,
        now: () => new Date(),
        idFactory: () => randomUUID(),
      });
      validateFixLoop = validateFixLoopInstance;

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

      const makeArtifactStore = (runUuid: string, cwd: string): ArtifactStore =>
        artifactStoreForRun(runUuid, cwd);

      const buildContext = (run: Run): PhaseHandlerContext => {
        const cwd = join(opts.repoRoot, '.ai-worktrees', `issue-${run.issueNumber}`);
        const startCommitSha = runRepository.findByUuid(run.uuid)?.startCommitSha;
        return composeBuildPhaseHandlerContext(
          {
            runId: run.displayId,
            runUuid: run.uuid,
            repoFullName: resolvedRepoFullName ?? '',
            issueNumber: run.issueNumber,
            cwd,
            artifacts: makeArtifactStore(run.uuid, cwd),
            github: new GhCliAdapter(),
            git: gitAdapter,
            agent: artifactAgent,
            events: eventBus,
            now: () => new Date(),
          },
          {
            promptsRoot: join(opts.repoRoot, 'prompts'),
            expectedBranch: `ai/issue-${run.issueNumber}`,
            baseBranch: opts.baseBranch ?? resolvedDefaultBranch,
            ...(startCommitSha ? { startCommitSha } : {}),
          },
        );
      };
      buildRunContext = buildContext;

      const runImplement = async (ctx: StepLoopContext, opts?: ImplementStepOptions) => {
        const run = runRepository.findByUuid(String(ctx.runId));
        const runDir = run?.displayId ?? String(ctx.runId);
        const issueNumber = run?.issueNumber ?? 0;
        const branchName = `ai/issue-${issueNumber}`;
        const artifacts = artifactStoreForRun(String(ctx.runId), ctx.cwd);

        let manifest: TaskManifest | undefined;
        try {
          const manifestJson = await artifacts.read(String(ctx.runId), 'task-manifest.json');
          const parsed = parseTaskManifest(manifestJson);
          if (parsed.success) {
            manifest = parsed.manifest;
          } else {
            persistingEventBusForLoop.publish(String(ctx.runId), {
              runId: String(ctx.runId),
              level: 'error',
              type: 'agent.invoke_failed',
              message: `Failed to parse task-manifest.json: ${parsed.error}`,
              timestamp: new Date().toISOString(),
              metadata: { phaseId: 'implement', stepIndex: ctx.stepIndex },
            });
            return { invocationId: '', agentOutcome: 'failed' as const };
          }
        } catch (err) {
          if (!(err instanceof ArtifactNotFoundError)) {
            const msg = err instanceof Error ? err.message : String(err);
            persistingEventBusForLoop.publish(String(ctx.runId), {
              runId: String(ctx.runId),
              level: 'error',
              type: 'agent.invoke_failed',
              message: `Failed to read task-manifest.json: ${msg}`,
              timestamp: new Date().toISOString(),
              metadata: { phaseId: 'implement', stepIndex: ctx.stepIndex },
            });
            return { invocationId: '', agentOutcome: 'failed' as const };
          }
        }

        let planMd: string;
        try {
          planMd = await artifacts.read(String(ctx.runId), 'plan.md');
        } catch (err) {
          const msg =
            err instanceof ArtifactNotFoundError
              ? 'plan.md not found in artifact store'
              : `Failed to read plan.md: ${err instanceof Error ? err.message : String(err)}`;
          persistingEventBusForLoop.publish(String(ctx.runId), {
            runId: String(ctx.runId),
            level: 'error',
            type: 'agent.invoke_failed',
            message: msg,
            timestamp: new Date().toISOString(),
            metadata: { phaseId: 'implement', stepIndex: ctx.stepIndex },
          });
          return { invocationId: '', agentOutcome: 'failed' as const };
        }

        const task = manifest?.tasks.find((t) => t.n === ctx.stepIndex);
        const taskTextResult = extractTaskBody(planMd, {
          taskNumber: ctx.stepIndex,
          ...(task?.title !== undefined ? { title: task.title } : {}),
        });
        if (!taskTextResult.ok) {
          persistingEventBusForLoop.publish(String(ctx.runId), {
            runId: String(ctx.runId),
            level: 'error',
            type: 'agent.invoke_failed',
            message:
              taskTextResult.reason === 'missing_heading'
                ? `Task ${ctx.stepIndex} has no matching heading in plan.md`
                : `Task ${ctx.stepIndex} is only present inside a balanced code fence`,
            timestamp: new Date().toISOString(),
            metadata: { phaseId: 'implement', stepIndex: ctx.stepIndex },
          });
          return { invocationId: '', agentOutcome: 'failed' as const };
        }

        const taskText = taskTextResult.body.trim();
        const promptDir = join(baseTmpDir, 'implement-step-prompts');
        mkdirSync(promptDir, { recursive: true });
        const promptPath = join(promptDir, `implement-${String(ctx.runId)}-${ctx.stepIndex}.md`);
        const implementPrompt = buildImplementPrompt(
          ctx,
          taskText,
          branchName,
          opts?.typecheckErrors,
        );
        writeFileSync(promptPath, implementPrompt, 'utf-8');
        const startCommitSha = resolveStartCommitSha(ctx.cwd, String(ctx.runId));
        let result;
        try {
          result = await artifactAgent.invoke({
            profile: AgentProfileName(implementProfileName),
            promptPath,
            expectedArtifacts: ['implementation-log.md'],
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
        let buildError = '';
        try {
          execFileSync('pnpm', ['-r', 'build'], {
            cwd: ctx.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf-8',
            timeout: 180_000,
          });
        } catch (err) {
          buildError = captureExecOutput(err);
          // Non-fatal: let the typecheck surface precise errors
        }
        try {
          execFileSync('pnpm', ['-r', 'typecheck'], {
            cwd: ctx.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf-8',
          });
          if (buildError) {
            return {
              outcome: 'fail',
              output: buildError,
              structuredErrors: parseTypescriptErrors(buildError),
            };
          }
          return { outcome: 'pass', output: '' };
        } catch (err) {
          const raw =
            err instanceof Error && 'stdout' in err && 'stderr' in err
              ? `${String((err as NodeJS.ErrnoException & { stdout?: string }).stdout ?? '')}${String((err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? '')}`
              : String(err);
          const lines = raw.split('\n');
          const truncated = lines.length > 100 ? lines.slice(-100).join('\n') : raw;
          return {
            outcome: 'fail',
            output: truncated.slice(0, 3000),
            structuredErrors: parseTypescriptErrors(truncated.slice(0, 3000)),
          };
        }
      };

      const runSpecReview = async (ctx: StepLoopContext, tcResult: TypecheckResult) => {
        const promptDir = join(baseTmpDir, 'implement-step-prompts');
        mkdirSync(promptDir, { recursive: true });
        const promptPath = join(
          promptDir,
          `spec-review-${String(ctx.runId)}-${ctx.stepIndex}-${ctx.iterationIndex}.md`,
        );
        const typecheckSection =
          tcResult.outcome === 'pass'
            ? "## TYPECHECK RESULT (do not re-run — read-only phase)\nThe orchestrator ran `pnpm -r typecheck` after implement completed.\nResult: PASS\n\nBUILD GREEN OVERRIDES THE PLAN'S LETTER: a plan-letter deviation that compiles is acceptable; do NOT return SPEC_FAIL for it."
            : `## TYPECHECK RESULT (do not re-run — read-only phase)\nThe orchestrator ran \`pnpm -r typecheck\` after implement completed.\nResult: FAIL\n\nTypecheck errors (last 100 lines):\n${tcResult.output}\n\nSurface the type errors; do NOT proceed to plan-letter checks until the type error is resolved.`;

        const artifacts = artifactStoreForRun(String(ctx.runId), ctx.cwd);
        let implReport = '';
        try {
          implReport = await artifacts.read(String(ctx.runId), 'implementation-log.md');
        } catch (err) {
          if (!(err instanceof ArtifactNotFoundError)) throw err;
        }
        const reviewPrompt = buildSpecReviewPrompt(ctx, typecheckSection, implReport);
        writeFileSync(promptPath, reviewPrompt, 'utf-8');
        const startCommitSha = resolveStartCommitSha(ctx.cwd, String(ctx.runId));
        let result;
        try {
          result = await artifactAgent.invoke({
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
          { artifacts, agent: artifactAgent },
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
        const typecheckSection =
          tcResult.outcome === 'pass'
            ? "## TYPECHECK RESULT (do not re-run — read-only phase)\nThe orchestrator ran `pnpm -r typecheck` after implement completed.\nResult: PASS\n\nBUILD GREEN OVERRIDES THE PLAN'S LETTER: a plan-letter deviation that compiles is acceptable; do NOT return QUALITY_FAIL for it."
            : `## TYPECHECK RESULT (do not re-run — read-only phase)\nThe orchestrator ran \`pnpm -r typecheck\` after implement completed.\nResult: FAIL\n\nTypecheck errors (last 100 lines):\n${tcResult.output}\n\nSurface the type errors; do NOT proceed to quality checks until the type error is resolved.`;

        const reviewPrompt = buildQualityReviewPrompt(ctx, typecheckSection);
        writeFileSync(promptPath, reviewPrompt, 'utf-8');
        const startCommitSha = resolveStartCommitSha(ctx.cwd, String(ctx.runId));
        let result;
        try {
          result = await artifactAgent.invoke({
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
        const artifacts = artifactStoreForRun(String(ctx.runId), ctx.cwd);
        const verdict = await readReviewVerdict(
          patched,
          { artifacts, agent: artifactAgent },
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
          'Write result.json: { "result": "done_with_fixes" } | { "result": "done_no_fixes_needed", "rebuttal": "<reason>" } | { "result": "cannot_fix" }',
        ].join('\n');
        writeFileSync(promptPath, fixPrompt, 'utf-8');
        const startCommitSha = resolveStartCommitSha(ctx.cwd, String(ctx.runId));
        let invokeResult;
        try {
          invokeResult = await artifactAgent.invoke({
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
        const artifacts = artifactStoreForRun(String(ctx.runId), ctx.cwd);
        const fixVerdict = await readFixVerdict(patched, {
          artifacts,
          agent: artifactAgent,
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
      }): Promise<{ outcome: 'success' | 'failed' | 'needs_human_review' }> => {
        if (!implementStepLoop) throw new Error('implementStepLoop not initialized');
        const result = await implementStepLoop.execute({
          runId: RunId(sctx.ctx.runUuid),
          phaseId: PhaseName('implement'),
          repoId: sctx.ctx.repoFullName,
          cwd: sctx.cwd,
          stepIndex: sctx.stepIndex,
          stepTitle: sctx.stepTitle,
          maxIterations: config.phases.implement.maxIterations,
          maxTypeCheckRetries: config.phases.implement.maxTypeCheckRetries,
        });
        return { outcome: result.outcome };
      };

      // Wire remaining phase handlers that require agent dependencies
      phaseRegistry.register(new PlanDesignHandler());
      phaseRegistry.register(new PlanWriteHandler());
      phaseRegistry.register(new CompoundHandler());

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
          try {
            execFileSync('pnpm', ['-r', 'build'], {
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
            console.error('[implement setup] pnpm -r build failed:', msg, stderr);
            return { ok: false, error: `pnpm -r build failed: ${msg}${stderr}` };
          }
        }

        return { ok: true };
      };

      const lintTaskSizeDep = buildLintTaskSize({
        maxTestFileLines: config.taskSplitting.maxTestFileLines,
        maxTestCases: config.taskSplitting.maxTestCases,
        blockOversizedTasks: config.taskSplitting.blockOversizedTasks,
      });

      phaseRegistry.register(
        new ImplementHandler({
          steps: stepRepository,
          runStep,
          setup: worktreeSetup,
          lintTaskSize: lintTaskSizeDep,
        }),
      );

      phaseRegistry.register(
        new ValidateHandler({
          runValidation,
          commands: config.validation.commands,
          timeoutSeconds: config.validation.timeout,
          logDir: join(runsDir, 'validate'),
          fixValidateEnabled: config.phases.fixValidate?.enabled !== false,
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
        new ReviewFixHandler({
          runLoop: async (ctx) => {
            const result = await reviewFixLoopInstance.execute({
              runId: RunId(ctx.runUuid),
              phaseId: PhaseName('review-fix'),
              repoId: ctx.repoFullName,
              cwd: ctx.cwd,
              maxIterations: config.phases.reviewFix.maxIterations,
              blockOnSeverity: config.phases.reviewFix.blockOnSeverity,
              reviewProfile: AgentProfileName(reviewProfileName),
              fixProfile: AgentProfileName(resolveProfileBound('fix-review')),
            });
            return {
              phaseOutcome: result.phaseOutcome,
              loopStatus: result.loop.status as 'converged' | 'failed' | 'exhausted',
            };
          },
        }),
      );

      phaseRegistry.register(
        new CreatePrHandler({
          baseBranch: resolvedDefaultBranch,
          headBranch: (ctx) => `ai/issue-${ctx.issueNumber}`,
        }),
      );

      phaseRegistry.register(
        new PostPrReviewHandler({
          runPoll: async (ctx) => {
            let prNumber: number;
            try {
              const prUrl = (await ctx.artifacts.read(ctx.runUuid, 'pr-url.txt')).trim();
              const match = prUrl.match(/\/pull\/(\d+)/);
              if (!match) {
                return { signal: 'blocked' as const };
              }
              prNumber = parseInt(match[1]!, 10);
            } catch {
              return { signal: 'blocked' as const };
            }

            // Fast-path: if the PR is already closed/merged, short-circuit.
            try {
              const ghAdapterForPoll = new GhCliAdapter({});
              const prDetail = await ghAdapterForPoll.getPr(ctx.repoFullName, prNumber);
              if (prDetail.state === 'merged') return { signal: 'merged' as const };
              if (prDetail.state === 'closed') return { signal: 'cancelled' as const };
            } catch {
              // Non-fatal — fall through to the poller which will handle it.
            }

            const poller = buildPrReviewPoller({
              maxPolls: config.phases.postPrReview?.maxPolls ?? 10,
              pollIntervalMs: (config.phases.postPrReview?.pollIntervalSeconds ?? 60) * 1000,
              readyMaxDays: config.timeouts.readyMaxDays,
              phaseStartedAt: ctx.now(),
              baseBranch: resolvedDefaultBranch,
            });
            const result = await poller.run({
              runId: RunId(ctx.runUuid),
              repoId: ctx.repoFullName as RepositoryId,
              repoFullName: ctx.repoFullName,
              prNumber,
              cwd: ctx.cwd,
              phaseId: PhaseName('post-pr-review'),
            });
            return { signal: result.terminalState };
          },
          setRunStatus: (runUuid, status: import('@ai-sdlc/domain').RunStatus) => {
            runRepository.update(runUuid, {
              status: status as import('@ai-sdlc/domain').RunStatus,
            });
          },
        }),
      );

      runExecutor = new RunExecutor({
        runRepository,
        failureRepository,
        phaseRepository,
        events: eventBus,
        registry: phaseRegistry,
        contextFactory: buildContext,
      });
    }
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    if ((err.cause as { code?: string })?.code !== 'ENOENT') throw err;
  }

  const singleRepo: RepositoryPort = resolvedRepoFullName
    ? new SingleRepoAdapter({
        id: RepositoryId(resolvedRepoFullName),
        owner: resolvedRepoFullName.split('/')[0]!,
        name: resolvedRepoFullName.split('/')[1]!,
        fullName: resolvedRepoFullName,
        defaultBranch: resolvedDefaultBranch,
        localBasePath: opts.repoRoot,
        enabled: true,
        maxConcurrentRuns: 1 as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    : new SingleRepoAdapter({
        id: '' as RepositoryId,
        owner: '',
        name: '',
        fullName: '',
        defaultBranch: '',
        localBasePath: '',
        enabled: false,
        maxConcurrentRuns: 1 as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

  const jobQueue = new JobQueueRepository(db, singleRepo);

  const workerRegistry = new WorkerRegistryRepository(db);

  const workerLoopDeps: Omit<WorkerLoopDeps, 'recoverableRunIds'> | undefined =
    runExecutor !== undefined
      ? {
          registry: workerRegistry,
          queue: jobQueue,
          leases: workerLeaseRepository,
          repos: singleRepo,
          executeRun: async ({ run, signal: _signal }) => {
            runRepository.update(run.uuid, { pid: process.pid });
            const result = await runExecutor.execute({ run, skip: [], presentArtifacts: [] });
            return { ok: result.run.status === 'passed' };
          },
          prepareWorktree: async ({ runId, signal: _signal }) => {
            const r = runRepository.findByUuid(runId);
            if (!r) throw new Error(`prepareWorktree: no run found for ${runId}`);
            const worktreePath = join(opts.repoRoot, '.ai-worktrees', `issue-${r.issueNumber}`);
            await gitAdapter.createWorktree({
              repoLocalBasePath: opts.repoRoot,
              worktreePath,
              branch: `ai/issue-${r.issueNumber}`,
              baseBranch: resolvedDefaultBranch,
            });
            if ('seedArtifactExcludes' in gitAdapter) {
              await (gitAdapter as ArtifactGuardPort).seedArtifactExcludes(worktreePath);
            }
            const sha = await gitAdapter.headCommitSha(worktreePath);
            runRepository.update(r.uuid, { startCommitSha: sha });
            return { cwd: worktreePath };
          },
          resetWorktree: (repoId) => {
            const lease = workerLeaseRepository.current(repoId);
            if (!lease) return;
            const r = runRepository.findByUuid(lease.runId);
            if (!r) return;
            const worktreePath = join(opts.repoRoot, '.ai-worktrees', `issue-${r.issueNumber}`);
            gitAdapter.resetWorktreeIfClean(worktreePath, resolvedDefaultBranch).catch(() => {});
          },
          isWorkerAlive: (workerId) => {
            const w = workerRegistry.findById(workerId);
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
          onLeaseReclaimed: (info) => {
            logger.error(
              `Lease reclaimed: repo=${info.repoId} prev=${info.previousWorkerId} by=${info.reclaimedByWorkerId}: ${info.reason}`,
            );
          },
        }
      : undefined;

  const resumeRun = new ResumeRun({
    runRepository,
    repos: singleRepo,
    leases: workerLeaseRepository,
    queue: jobQueue,
    stepRepo: stepRepository,
    phaseRepo: phaseRepository,
    logger,
  }) as unknown as Container['resumeRun'];

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

    const processor = new ProcessPrReviewComments({
      github: ghAdapter,
      git: gitAdapter,
      agent: prReviewAgent,
      prReviewRepo: prReviewRepository,
      renderTaskPrompt: async ({
        cwd,
        comment,
        diff,
        branch: _branch,
        previousBuildError,
        previousCodeVerifyReason,
      }) => {
        const promptDir = join(baseTmpDir, 'pr-review-prompt');
        mkdirSync(promptDir, { recursive: true });
        const promptPath = join(promptDir, `prompt-${comment.commentId}.md`);
        const content = buildPostPrReviewTaskPrompt({
          cwd,
          comment,
          diff,
          ...(previousBuildError !== undefined ? { previousBuildError } : {}),
          ...(previousCodeVerifyReason !== undefined ? { previousCodeVerifyReason } : {}),
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
            return { passed: true };
          }
          const buildCheckId = `pr-review-build-check-${randomUUID()}`;
          const runDir = runRepository.findByUuid(runId)?.displayId ?? runId;
          const logDir = join(runsDir, runDir, buildCheckId);
          const result = await runValidation.execute({
            runId: RunId(runId),
            phaseId: PhaseName('post-pr-review'),
            cwd,
            logDir,
            logPathPrefix: buildCheckId,
            commands: config.validation.commands,
            timeoutSeconds: config.validation.timeout,
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

          let diffOutput = '';
          try {
            diffOutput = execFileSync('git', ['diff', startCommitSha, fixCommitSha, '--', path], {
              cwd,
              encoding: 'utf-8',
            });
          } catch {
            diffOutput = '(could not produce diff)';
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
            '## Diff Applied',
            '',
            '```diff',
            diffOutput,
            '```',
            '',
            '## Your Task',
            '',
            'Does the diff above actually address the review comment? Answer strictly.',
            '',
            'Write `result.json` in the current directory:',
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
      maxReactivations: 100,
    });
  }

  const composeBuildPhaseHandlerContext: PhaseHandlerContextFactory = (base, opts) => {
    const idFactory = () => randomUUID();
    return {
      ...base,
      ...(resolveProfileForPhaseBound ? { resolveProfile: resolveProfileForPhaseBound } : {}),
      idFactory,
      ...opts,
    };
  };

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
    workerLeaseRepository,
    jobQueue,
    workerRegistry,
    ...(workerLoopDeps !== undefined ? { workerLoopDeps } : {}),
    git: gitAdapter,
    ...(resolvedRepoFullName !== undefined ? { repoFullName: resolvedRepoFullName } : {}),
    runValidation,
    startIssueRun,
    cancelRun,
    stepRepository,
    resumeRun,
    retryFailedPhase,
    runsDir,
    baseTmpDir,
    defaultBranch: resolvedDefaultBranch,
    eventBus,
    ...(agentRuntime ? { agentRuntime } : {}),
    ...(buildRunContext !== undefined ? { buildRunContext } : {}),
    resolveProfileForPhase: resolveProfileForPhaseBound ?? defaultResolve,
    buildPrReviewPoller,
    ...(reviewFixLoop !== undefined ? { reviewFixLoop } : {}),
    ...(validateFixLoop !== undefined ? { validateFixLoop } : {}),
    ...(implementStepLoop !== undefined ? { implementStepLoop } : {}),
    ...(runStep !== undefined ? { runStep } : {}),
    buildPhaseHandlerContext: composeBuildPhaseHandlerContext,
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

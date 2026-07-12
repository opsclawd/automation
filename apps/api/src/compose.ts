import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  open as fsOpen,
  stat as fsStat,
  access as fsAccess,
  readFile as fsReadFile,
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
  RepositoryMetadataResolver,
  createFilesystemArtifactStore,
  FileTailer,
  createFixDiffInspector,
  createFindingEvidenceInspector,
  listProcesses,
  killProcess,
  ReviewStateRepository,
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
  OrphanedRunsSweeper,
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
  CheckMergeReadiness,
  ImplementStepLoop,
  PlanReviewLoop,
  parsePlanReviewFindings,
  type PlanReviewLoopDeps,
  type PlanReviewFinding,
  PlanReviewHandler,
  readReviewVerdict,
  readFixVerdict,
  PhaseHandlerRegistry,
  RunExecutor,
  type WorkerLoopDeps,
  type WorkerRegistryPort,
  ArtifactNotFoundError,
  type ArtifactStore,
  type StartIssueRunDeps,
  type ClassifyExitFn,
  type EventTailerFactory,
  type EventBusPort,
  type RunRecord,
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
  type ImplementStepLoopDeps,
  type ImplementStepLoop as ImplementStepLoopType,
  type StepLoopContext,
  type ImplementFixStepOptions,
  type ImplementStepOptions,
  type ArbiterResult,
  type TypecheckResult,
  type TypescriptError,
  type ResolveRefShaFn,
  type ImplementArtifactGuardInput,
  type SynthesizeFromTranscriptInput,
  type SynthesizeFromTranscriptPort as _SynthesizeFromTranscriptPort,
  arbiterResultSchema,
  planFixResultSchema,
  specReviewResultSchema,
  qualityReviewResultSchema,
  specReviewFindingSchema,
  qualityReviewFindingSchema,
  extractResult,
  extractTaskBody,
  loadPromptTemplate,
  renderPrompt,
  parseTaskManifest,
  validatePlanTaskList,
  parseTypescriptErrors,
  renderStructuredTypecheckErrors,
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
  TaskContextGenerator,
  type HolisticFile,
  fingerprintFinding,
} from '@ai-sdlc/application';
import {
  ConfigError,
  DEFAULT_FIRST_REVIEW_GRACE_WINDOW_SECONDS,
  loadConfig,
  loadLayeredConfig,
  type LoadedConfig,
  type OrchestratorConfig,
  PHASE_FALLBACKS,
  type AgentConfig,
} from '@ai-sdlc/shared';
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
  ImplementArtifactGuard,
  SynthesizeFromTranscript,
  RepositoryRegistryRepository,
  StructuredResultRepair,
} from '@ai-sdlc/infrastructure';
import { createArtifactCapturingAgent } from './durable-agent-artifacts.js';
import {
  buildArbiterPrompt,
  buildImplementStepFinalReviewArbiterPrompt,
} from './arbiter-prompt.js';
import { resolveArbiterProfileName } from './arbiter-profile.js';
import { buildArchitectPrompt } from './architect-prompt.js';
import { resolveArchitectProfileName } from './architect-profile.js';
import { architectPlanSchema } from '@ai-sdlc/application';
import {
  FIX_RESULT_ARTIFACT,
  QUALITY_REVIEW_RESULT_ARTIFACT,
  SPEC_REVIEW_RESULT_ARTIFACT,
  readArbiterExcerpts,
  readImplementStepFinalReviewExcerpts,
} from './arbiter-excerpts.js';
import { buildLintTaskSize } from './lint-task-size.js';
import {
  buildReviewFixReviewPrompt,
  buildReviewFixFixPrompt,
  buildWholePrArbiterPrompt,
} from './review-fix-prompts.js';
import { createReviewLoopHistoryFilePort } from './review-loop-history-file-port.js';
import { createImplementStepHistoryFilePort } from './implement-step-history-file-port.js';
import {
  buildPlanReviewArbiterPrompt,
  buildPlanReviewReviewScopeBlock,
  readPlanReviewExcerpts,
  buildPlanReviewFinalReviewArbiterPrompt,
  readPlanReviewFinalExcerpts,
  getRecentFixCitations,
  createPlanReviewEvidenceResolver,
  PLAN_REVIEW_FINDINGS_ARTIFACT,
  PLAN_FIX_RESULT_ARTIFACT,
  buildPlanReviewFixPrompt,
} from './plan-review-prompts.js';
import { WORKSPACE_CONSTRAINTS } from '@ai-sdlc/application';

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

export function buildImplementPrompt(
  ctx: { stepIndex: number; stepTitle: string; cwd: string; repoId: string },
  taskContext: string,
  branchName: string,
  typecheckErrors?: TypescriptError[] | string,
): string {
  const taskN = ctx.stepIndex;
  const taskTitle = ctx.stepTitle;

  const structuredErrors: TypescriptError[] | undefined =
    typeof typecheckErrors === 'string' ? parseTypescriptErrors(typecheckErrors) : typecheckErrors;

  return [
    `You are implementing Task ${taskN}: ${taskTitle}`,
    '',
    taskContext,
    '',
    '## Context Supplement',
    '',
    WORKSPACE_CONSTRAINTS,
    '',
    `You are working in: ${ctx.cwd}`,
    `Repository: ${ctx.repoId}`,
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
    `1. Review the Task Context above. It contains requirements, design sections,`,
    `   and dependency summaries relevant to Task ${taskN}. Use it as your`,
    `   primary guide. You may still read repository files (including issue.md,`,
    `   design.md, and plan.md) if you need more detail, but the context artifact`,
    `   is authoritative for this task's scope.`,
    `2. Implement exactly what Task ${taskN} specifies — nothing more.`,
    `3. Write tests following TDD where applicable, scoped to Task ${taskN}.`,
    '   IF the Task Context above includes a "Behavioral Invariants" section,',
    '   you MUST write the named tests listed there BEFORE implementation.',
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
  workerLoopDeps?: Omit<WorkerLoopDeps, 'recoverableRunIds'>;
  serveSweepIntervalSeconds: number;
  buildWaitingRunsSweeper: () => import('@ai-sdlc/application').WaitingRunsSweeper;
  buildOrphanedRunsSweeper: () => import('@ai-sdlc/application').OrphanedRunsSweeper;
  /** Exposed for worktree lifecycle management in CLI and tests. */
  git: GitPort;
  /** Context factory for a full run (includes promptsRoot, expectedBranch, cwd). Only present when agent config is loaded. */
  buildRunContext?: (run: Run) => PhaseHandlerContext;
  repoFullName: string;
  targetRepoRoot: string;
  runValidation: RunValidation;
  startIssueRun: StartIssueRun;
  loadRepositoryForRun: LoadRepositoryForRun;
  cancelRun: CancelRun;
  checkMergeReadiness: CheckMergeReadiness;
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
  repoDefaultBranch: string;
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
    manifest: TaskManifest;
    planMd: string;
  }) => Promise<{ outcome: 'success' | 'failed' | 'needs_human_review' }>;
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

export interface BuildSpecReviewPromptOptions {
  ctx: { stepIndex: number; stepTitle: string; cwd: string };
  typecheckSection: string;
  implReport?: string;
  scope: {
    mode: 'initial_full' | 'intermediate_delta' | 'final_full';
    dimensions?: Array<'spec' | 'quality'>;
    baseIdentity?: string;
    snapshotIdentity?: string;
    unresolvedFindings?: Array<{
      fingerprint: string;
      severity: string;
      summary: string;
      file?: string;
      suggested_fix?: string;
    }>;
    dispositions?: Array<{
      fingerprint: string;
      disposition: string;
      reason?: string;
    }>;
  };
}

export function buildSpecReviewPrompt(options: BuildSpecReviewPromptOptions): string {
  const { ctx, typecheckSection, implReport = '', scope } = options;
  const { mode, baseIdentity, snapshotIdentity, unresolvedFindings, dispositions } = scope;
  const reportExcerpt = implReport.split('\n').slice(0, 50).join('\n');

  const sections: string[] = [];

  sections.push('# TASK', `Review implementation of step ${ctx.stepIndex}: ${ctx.stepTitle}`, '');

  if (mode === 'intermediate_delta') {
    sections.push(
      '## REVIEW MODE: DELTA (intermediate)',
      '',
      'This is an intermediate delta review. Focus on changes since the last review.',
      '',
    );

    if (baseIdentity && snapshotIdentity) {
      sections.push(
        `## EXACT DIFF COMMAND`,
        `Run: git diff ${baseIdentity}..${snapshotIdentity}`,
        '',
      );
    }

    sections.push(
      '## HARD CONSTRAINT — READ-ONLY REVIEW',
      'You MUST NOT run tests, run builds, or invoke any tool that modifies the',
      'filesystem or executes application/test code. Read-only shell commands for',
      'inspection are fine and often necessary (e.g. cat, ls, grep, git diff, git log,',
      'git show) — if your runtime has no dedicated file-read tool, use these instead',
      'of declining to review. Review by reading files only.',
      '',
    );

    if (unresolvedFindings && unresolvedFindings.length > 0) {
      sections.push(
        '## UNRESOLVED FINDINGS (from prior review)',
        'These findings were marked as unresolved. Verify whether they are still present:',
        '',
        ...unresolvedFindings.map(
          (f) => `- [${f.severity}] ${f.summary}${f.file ? ` (${f.file})` : ''}`,
        ),
        '',
        '## SETTLED FINDINGS REQUIRE NEW DELTA EVIDENCE',
        'If a finding was previously marked as addressed/rebutted/settled, you MUST see',
        'new evidence in the delta to re-flag it. A finding is only valid if it can be',
        'directly attributed to a change in the delta.',
        '',
      );
    }

    if (dispositions && dispositions.length > 0) {
      sections.push(
        '## PRIOR DISPOSITIONS',
        ...dispositions.map((d) => `- ${d.fingerprint}: ${d.disposition}`),
        '',
      );
    }
  } else {
    sections.push(
      `## REVIEW MODE: ${mode === 'initial_full' ? 'INITIAL FULL' : 'FINAL FULL'}`,
      '',
      'This is a full review. Inspect the complete implementation scope.',
      '',
      '## HARD CONSTRAINT — READ-ONLY REVIEW',
      'You MUST NOT run tests, run builds, or invoke any tool that modifies the',
      'filesystem or executes application/test code. Read-only shell commands for',
      'inspection are fine and often necessary (e.g. cat, ls, grep, git diff, git log,',
      'git show) — if your runtime has no dedicated file-read tool, use these instead',
      'of declining to review. Review by reading files only:',
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
    );
  }

  sections.push(
    '## CONTEXT',
    '',
    WORKSPACE_CONSTRAINTS,
    '',
    `Working directory: ${ctx.cwd}`,
    '',
    typecheckSection,
    '',
    '## OUTPUT',
    `Write ${ctx.cwd}/result.json with this shape (no extra keys, no comments):`,
    '',
    '  {',
    '    "result": "pass" | "fail",',
    '    "findings": [',
    '      {',
    '        "severity": "P0" | "P1" | "P2" | "P3",',
    '        "summary": "<one-sentence statement of the defect>",',
    '        "file": "<optional repo-relative path>",',
    '        "suggested_fix": "<optional concrete fix>"',
    '      }',
    '    ]',
    '  }',
    '',
    'Rules:',
    '- "findings" MUST be present and an array (use `[]` on pass).',
    '- When result is "fail", findings MUST contain at least one entry with severity P0..P3.',
    "- Every finding's `summary` is required and MUST be non-empty.",
    '- `file` and `suggested_fix` are STRONGLY RECOMMENDED for actionable findings; they may be omitted when the defect spans multiple files or is a plan/letter deviation.',
    '- Do NOT omit `findings` on "fail" — the orchestrator\'s fixer and arbiter cannot act on a fail verdict without findings.',
    'Do NOT write to a relative path — use the full absolute path above.',
    'You MUST use your file-write tool to create result.json on disk. Printing the',
    'JSON in your chat response instead of writing the file is a contract violation —',
    'the orchestrator only reads the file, never your response text.',
    '',
    '## STOP RULE — THIS IS THE MOST IMPORTANT RULE',
    'After writing result.json you are DONE. Do NOT:',
    '- Re-read any files',
    '- Re-verify your work',
    '- Run any commands',
    '- Start the review over',
    '- Do anything at all',
    'Any action after writing result.json is a contract violation.',
  );

  return sections.join('\n');
}

export interface BuildQualityReviewPromptOptions {
  ctx: { stepIndex: number; stepTitle: string; cwd: string };
  typecheckSection: string;
  scope: {
    mode: 'initial_full' | 'intermediate_delta' | 'final_full';
    dimensions?: Array<'spec' | 'quality'>;
    baseIdentity?: string;
    snapshotIdentity?: string;
    unresolvedFindings?: Array<{
      fingerprint: string;
      severity: string;
      summary: string;
      file?: string;
      suggested_fix?: string;
    }>;
    dispositions?: Array<{
      fingerprint: string;
      disposition: string;
      reason?: string;
    }>;
  };
}

export function buildQualityReviewPrompt(options: BuildQualityReviewPromptOptions): string {
  const { ctx, typecheckSection, scope } = options;
  const { mode, baseIdentity, snapshotIdentity, unresolvedFindings, dispositions } = scope;

  const sections: string[] = [];

  sections.push(
    '# TASK',
    `Review implementation quality for step ${ctx.stepIndex}: ${ctx.stepTitle}`,
    '',
    'Check for code quality: maintainability, performance, security, test coverage.',
    '',
  );

  if (mode === 'intermediate_delta') {
    sections.push(
      '## REVIEW MODE: DELTA (intermediate)',
      '',
      'This is an intermediate delta review. Focus on quality issues in changes since the last review.',
      '',
    );

    if (baseIdentity && snapshotIdentity) {
      sections.push(
        '## EXACT DIFF COMMAND',
        `Run: git diff ${baseIdentity}..${snapshotIdentity}`,
        '',
      );
    }

    sections.push(
      '## HARD CONSTRAINT — READ-ONLY REVIEW',
      'You MUST NOT run tests, run builds, or invoke any tool that modifies the',
      'filesystem or executes application/test code. Read-only shell commands for',
      'inspection are fine and often necessary (e.g. cat, ls, grep, git diff, git log,',
      'git show) — if your runtime has no dedicated file-read tool, use these instead',
      'of declining to review.',
      '',
    );

    if (unresolvedFindings && unresolvedFindings.length > 0) {
      sections.push(
        '## UNRESOLVED FINDINGS (from prior review)',
        'These findings were marked as unresolved. Verify whether they are still present:',
        '',
        ...unresolvedFindings.map(
          (f) => `- [${f.severity}] ${f.summary}${f.file ? ` (${f.file})` : ''}`,
        ),
        '',
        '## SETTLED FINDINGS REQUIRE NEW DELTA EVIDENCE',
        'If a finding was previously marked as addressed/rebutted/settled, you MUST see',
        'new evidence in the delta to re-flag it.',
        '',
      );
    }

    if (dispositions && dispositions.length > 0) {
      sections.push(
        '## PRIOR DISPOSITIONS',
        ...dispositions.map((d) => `- ${d.fingerprint}: ${d.disposition}`),
        '',
      );
    }
  } else {
    sections.push(
      `## REVIEW MODE: ${mode === 'initial_full' ? 'INITIAL FULL' : 'FINAL FULL'}`,
      '',
      'This is a full review. Inspect the complete implementation scope.',
      '',
      '## HARD CONSTRAINT — READ-ONLY REVIEW',
      'You MUST NOT run tests, run builds, or invoke any tool that modifies the',
      'filesystem or executes application/test code. Read-only shell commands for',
      'inspection are fine and often necessary (e.g. cat, ls, grep, git diff, git log,',
      'git show) — if your runtime has no dedicated file-read tool, use these instead',
      'of declining to review. If the task was verification-only (no files changed),',
      'write result.json with "pass" — quality review does not apply to',
      'verification-only steps.',
      '',
    );
  }

  sections.push(
    '## CONTEXT',
    '',
    WORKSPACE_CONSTRAINTS,
    '',
    `Working directory: ${ctx.cwd}`,
    '',
    typecheckSection,
    '',
    '## OUTPUT',
    `Write ${ctx.cwd}/result.json with this shape (no extra keys, no comments):`,
    '',
    '  {',
    '    "result": "pass" | "fail",',
    '    "findings": [',
    '      {',
    '        "severity": "P0" | "P1" | "P2" | "P3",',
    '        "summary": "<one-sentence statement of the defect>",',
    '        "file": "<optional repo-relative path>",',
    '        "suggested_fix": "<optional concrete fix>"',
    '      }',
    '    ]',
    '  }',
    '',
    'Rules:',
    '- "findings" MUST be present and an array (use `[]` on pass).',
    '- When result is "fail", findings MUST contain at least one entry with severity P0..P3.',
    "- Every finding's `summary` is required and MUST be non-empty.",
    '- `file` and `suggested_fix` are STRONGLY RECOMMENDED for actionable findings; they may be omitted when the defect spans multiple files or is a plan/letter deviation.',
    '- Do NOT omit `findings` on "fail" — the orchestrator\'s fixer and arbiter cannot act on a fail verdict without findings.',
    'Do NOT write to a relative path — use the full absolute path above.',
    'You MUST use your file-write tool to create result.json on disk. Printing the',
    'JSON in your chat response instead of writing the file is a contract violation —',
    'the orchestrator only reads the file, never your response text.',
    '',
    '## JSON ESCAPING WARNING',
    'When writing the `suggested_fix` or `summary` strings, you MUST ensure valid',
    'JSON escaping. Specifically, backticks (`) and template-literal syntax (${...})',
    'are NOT valid JSON escape sequences. If you need to include a backtick in a',
    'JSON string, use the raw character (`) — do NOT escape it with a backslash.',
    'Only escape double quotes ("), backslashes (\\), and control characters as',
    'required by the JSON spec.',
  );

  return sections.join('\n');
}

export interface BuildImplementStepFixPromptInput {
  cwd: string;
  stepIndex: number;
  stepTitle: string;
  /**
   * Optional arbiter rationale from a prior `finding_valid` ruling.
   * Rendered as a labeled, instruction-bearing section so the fixer
   * addresses the finding rather than re-rebutting it.
   */
  reconciliationContext?: string;
  /**
   * Optional prior-fix-history prose. Pre-work for the fix-history
   * enhancement issue; rendered verbatim when provided, omitted when absent
   * (mirrors `buildReviewFixFixPrompt` in `apps/api/src/review-fix-prompts.ts`).
   */
  historyContext?: string;
  /**
   * Optional typecheck errors from the previous fix's reverted build.
   * Rendered as a labeled section so the fixer addresses them directly (#671).
   */
  typecheckErrors?:
    | string
    | { file: string; line: number; col: number; code: string; message: string }[];
  /**
   * True when this is the one-shot terminal escalation after the review loop
   * exhausted its budget (#763). Rendered as a framing block instructing the
   * fixer to address ALL open findings coherently in a single pass.
   */
  isTerminalFix?: boolean;
  /**
   * Optional holistic findings for repeat-offender files (#723). When
   * present, instructs the fixer to re-derive the affected unit holistically
   * to satisfy all listed constraints.
   */
  holisticFindings?: HolisticFile[];
}

export async function buildImplementStepFixPrompt(
  artifacts: ArtifactStore,
  runId: string,
  input: BuildImplementStepFixPromptInput,
): Promise<string> {
  const readFindings = async (
    archive: string,
  ): Promise<
    Array<{ severity: string; summary: string; file?: string; suggested_fix?: string }>
  > => {
    try {
      const raw = await artifacts.read(runId, archive);
      const parsed = JSON.parse(raw);
      const schema =
        archive === SPEC_REVIEW_RESULT_ARTIFACT
          ? specReviewResultSchema
          : qualityReviewResultSchema;
      const parsedResult = schema.safeParse(parsed);
      if (parsedResult.success) {
        return (parsedResult.data.findings || []).map((f) => {
          const item: { severity: string; summary: string; file?: string; suggested_fix?: string } =
            {
              severity: f.severity,
              summary: f.summary,
            };
          if (f.file !== undefined) {
            item.file = f.file;
          }
          if (f.suggested_fix !== undefined) {
            item.suggested_fix = f.suggested_fix;
          }
          return item;
        });
      }
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'findings' in parsed &&
        Array.isArray(parsed.findings)
      ) {
        const itemSchema =
          archive === SPEC_REVIEW_RESULT_ARTIFACT
            ? specReviewFindingSchema
            : qualityReviewFindingSchema;
        const items: Array<{
          severity: string;
          summary: string;
          file?: string;
          suggested_fix?: string;
        }> = [];
        for (const f of parsed.findings) {
          const itemResult = itemSchema.safeParse(f);
          if (itemResult.success) {
            const data = itemResult.data;
            const item: {
              severity: string;
              summary: string;
              file?: string;
              suggested_fix?: string;
            } = {
              severity: data.severity,
              summary: data.summary,
            };
            if (data.file !== undefined) {
              item.file = data.file;
            }
            if (data.suggested_fix !== undefined) {
              item.suggested_fix = data.suggested_fix;
            }
            items.push(item);
          }
        }
        return items;
      }
      return [];
    } catch (err) {
      if (!(err instanceof ArtifactNotFoundError)) {
        // Swallow other errors so the fixer is never blocked by a malformed archive.
        console.warn(`[buildImplementStepFixPrompt] failed to read ${archive}:`, err);
      }
      return [];
    }
  };

  const [specFindings, qualityFindings] = await Promise.all([
    readFindings(SPEC_REVIEW_RESULT_ARTIFACT),
    readFindings(QUALITY_REVIEW_RESULT_ARTIFACT),
  ]);

  return [
    '# TASK',
    `Fix implementation issues for step ${input.stepIndex}: ${input.stepTitle}`,
    '',
    ...(input.isTerminalFix
      ? [
          '## TERMINAL ATTEMPT — FINAL FIX PASS',
          '',
          'The review loop exhausted its iteration budget without converging. You are',
          'the terminal fixer: there will be no further review/fix rounds after this.',
          'Address ALL open findings from the history and the sections below in one',
          'coherent pass. Prefer re-deriving the affected functions so every finding',
          'is satisfied simultaneously over minimal point-patches — point-patches are',
          'how the previous rounds kept introducing adjacent regressions.',
          'Your work is accepted on deterministic verification (typecheck, validation',
          'commands, tests) — make sure they pass before committing.',
          '',
        ]
      : []),
    '## WHAT THE REVIEWERS FOUND (verbatim)',
    '',
    'The most-recent spec-review result.json findings:',
    '```json',
    JSON.stringify({ findings: specFindings }, null, 2),
    '```',
    '',
    'The most-recent quality-review result.json findings:',
    '```json',
    JSON.stringify({ findings: qualityFindings }, null, 2),
    '```',
    '',
    'Apply the suggested fixes when you can. If a finding is wrong or infeasible,',
    'write result.json with "done_no_fixes_needed" and a non-empty `rebuttal`',
    'citing the finding and your reason.',
    '',
    ...(input.holisticFindings && input.holisticFindings.length > 0
      ? [
          '## HOLISTIC RE-DERIVATION REQUIRED',
          '',
          'The following file(s) have repeated findings across multiple iterations.',
          'Instead of applying minimal point-patches, you MUST re-derive the affected',
          'functions or sections as a whole so they satisfy every listed constraint',
          'simultaneously. Point-patching these files has proven to be regressive.',
          '',
          ...input.holisticFindings.map((h) => {
            return [
              `### File: ${h.file}`,
              '',
              'All findings (open and resolved) to be satisfied as invariants:',
              '```json',
              JSON.stringify(h.findings, null, 2),
              '```',
              '',
            ].join('\n');
          }),
        ]
      : []),
    ...(input.reconciliationContext && input.reconciliationContext.trim().length > 0
      ? [
          '## ARBITER RULING — ADDRESS THIS FINDING',
          '',
          'The orchestrator escalated a review/fix contradiction to an arbiter, which ruled:',
          '',
          `> ${input.reconciliationContext}`,
          '',
          "The arbiter's verdict was **finding_valid**: the reviewer's finding was",
          "correct. The previous fix attempt's `done_no_fixes_needed` rebuttal was",
          'rejected. You MUST address the finding above — do NOT re-rebut it.',
          '',
          'Rules:',
          '- Apply the suggested fix, or write `done_with_fixes` only if a different',
          '  fix achieves the same intent.',
          '- Re-rebutting with the same argument will produce the same arbiter ruling.',
          "- If you still believe the finding is invalid after reading the arbiter's",
          '  evidence, write `cannot_fix` and cite what is materially new.',
          '',
        ]
      : []),
    ...(input.historyContext && input.historyContext.trim().length > 0
      ? ['## PRIOR FIX HISTORY', '', input.historyContext, '']
      : []),
    ...(input.typecheckErrors !== undefined
      ? [
          '## TYPECHECK ERRORS (previous fix)',
          '',
          'The previous fix produced a build-breaking tree that was reverted. These are the structured typecheck errors captured at the start of this iteration:',
          '',
          '```json',
          JSON.stringify(input.typecheckErrors, null, 2),
          '```',
          '',
        ]
      : []),
    '## CONTEXT',
    '',
    WORKSPACE_CONSTRAINTS,
    '',
    `Working directory: ${input.cwd}`,
    '',
    '## OUTPUT',
    `Write ${input.cwd}/result.json with this shape (no extra keys, no comments):`,
    '  { "result": "done_with_fixes" }',
    '  | { "result": "done_no_fixes_needed", "rebuttal": "<reason>" }',
    '  | { "result": "cannot_fix" }',
    '',
    '## COMMIT CONTRACT',
    'After fixing, commit your change before writing result.json:',
    '  1. Record HEAD before: `PRE_HEAD=$(git rev-parse HEAD)`',
    '  2. Stage and commit: `git add -A && git commit -m "fix: review findings"`',
    '  3. If git commit exits non-zero, the pre-commit hook failed. Read the hook/lint',
    '     output, FIX the reported errors, and retry the commit. Never report',
    '     result="done_with_fixes" with a failed or skipped commit.',
    '  4. After a successful commit, confirm HEAD advanced:',
    '     `[ "$(git rev-parse HEAD)" != "$PRE_HEAD" ] || { echo "COMMIT DID NOT ADVANCE HEAD"; exit 1; }`',
    '  5. Confirm clean worktree:',
    '     `[ -z "$(git status --porcelain)" ] || { echo "WORKTREE DIRTY AFTER COMMIT"; exit 1; }`',
    '  6. Only write "done_with_fixes" in result.json after steps 4 and 5 both pass.',
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
  mode: 'initial_full' | 'intermediate_delta';
  previousBuildError?: string;
  previousCodeVerifyReason?: string;
  dispositions?: Array<{
    fingerprint: string;
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
  if (process.env.VITEST && !existsSync(join(opts.repoRoot, '.ai-orchestrator.json'))) {
    try {
      writeFileSync(
        join(opts.repoRoot, '.ai-orchestrator.json'),
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
  const targetRoot = opts.targetRepoRoot ?? opts.repoRoot;
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

  const singleRepo: RepositoryPort = resolvedRepoFullName
    ? new SingleRepoAdapter({
        id: RepositoryId(resolvedRepoFullName),
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
        id: '' as RepositoryId,
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
  try {
    const cacheKey = `${opts.repoRoot}|${opts.targetRepoRoot ?? ''}`;
    let layered = layeredConfigCache.get(cacheKey);
    if (!layered) {
      layered = loadLayeredConfig({
        automationRoot: opts.repoRoot,
        ...(opts.targetRepoRoot !== undefined ? { targetRoot: opts.targetRepoRoot } : {}),
      });
      layeredConfigCache.set(cacheKey, layered);
    }
    fingerprint = layered.fingerprint;
    sources = layered.sources;
  } catch {
    // Ignore error here; the main config loader below will throw if config is invalid/missing.
  }

  const runRepository = new RunRepository(
    db,
    fingerprint,
    sources ? JSON.stringify(sources) : undefined,
  );
  const artifactRepository = new ArtifactRepository(db);
  const prReviewRepository = new PrReviewRepository(db);
  const eventBus = new InMemoryEventBus();

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
    const cacheKey = `${opts.repoRoot}|${opts.targetRepoRoot ?? ''}`;
    let sweepLayered = layeredConfigCache.get(cacheKey);
    if (!sweepLayered) {
      sweepLayered = loadLayeredConfig({
        automationRoot: opts.repoRoot,
        ...(opts.targetRepoRoot !== undefined ? { targetRoot: opts.targetRepoRoot } : {}),
      });
      layeredConfigCache.set(cacheKey, sweepLayered);
    }
    readyMaxDays = sweepLayered.config.timeouts.readyMaxDays;
    serveSweepIntervalSeconds = sweepLayered.config.serve.sweepIntervalSeconds;
  } catch {
    // Fallback to default 7 / disabled.
  }

  let ghAdapterForSweep: GhCliAdapter | undefined;
  const getGhAdapterForSweep = () => {
    if (!ghAdapterForSweep) {
      ghAdapterForSweep = new GhCliAdapter({});
    }
    return ghAdapterForSweep;
  };

  const sweepLogger: { error: (message: string, ...args: unknown[]) => void } = {
    error: (msg, ...args) => console.error(msg, ...args),
  };

  const workerLeaseRepository = new WorkerLeaseRepository(db);
  const jobQueue: JobQueuePort = new JobQueueRepository(db, registryBackedRepo);

  if (opts.runStartupSweeps !== false) {
    // Sweep orphaned runs before any new run starts
    const sweep = new SweepOrphanedRuns({
      runRepository,
      isProcessAlive: checkPid,
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
          eventBus,
          now: () => new Date(),
          logger: sweepLogger,
        });
        orphanSweeper
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
      eventBus,
      now: () => new Date(),
      readyMaxDays,
      applyReactivation: (run: RunRecord, decision: { action: string; reason: string }) => {
        applyReactivation(run as never, decision as never, {
          runRepository,
          eventBus,
          now: () => new Date(),
        });
      },
      resolvePrContext: async (run: RunRecord) => resolvePrContextForRun(run),
    });
    waitingSweep.execute().then(
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
  }

  const phaseRepository = new PhaseRepository(db);
  const eventRepository = new EventRepository(db);
  const failureRepository = new FailureRepository(db);
  const agentInvocationRepository = new AgentInvocationRepository(db);
  const validationRunRepository = new ValidationRunRepository(db);
  const agentUsageRepository = new AgentUsageRepository(db);
  const loopRepository = new LoopRepository(db);
  const validationAdapter = new ProcessValidationAdapter();
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
    eventRepository,
    eventBus,
    createEventTailer,
    baseTmpDir,
    tmpDirectoryFactory,
    repositoryPort: registryBackedRepo,
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
  let reviewFixLoop: ReviewFixLoop | undefined;
  let validateFixLoop: ValidateFixLoop | undefined;
  let implementStepLoop: ImplementStepLoopType | undefined;
  let runStep: Container['runStep'] | undefined;
  let runExecutor: RunExecutor | undefined;
  let buildRunContext: ((run: Run) => PhaseHandlerContext) | undefined;
  const reviewStateRepository = new ReviewStateRepository(db);
  try {
    const cacheKey = `${opts.repoRoot}|${opts.targetRepoRoot ?? ''}`;
    let layered = layeredConfigCache.get(cacheKey);
    if (!layered) {
      layered = loadLayeredConfig({
        automationRoot: opts.repoRoot,
        ...(opts.targetRepoRoot !== undefined ? { targetRoot: opts.targetRepoRoot } : {}),
      });
      layeredConfigCache.set(cacheKey, layered);
    }
    let config = applyCliOverrides(layered.config, opts);
    const _fingerprint = layered.fingerprint;
    const _sources = layered.sources;
    if (config.agent && config.agent.profiles) {
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
      const reviewProfileName: string =
        config.agent.phaseProfiles['whole-pr-review']?.profile ?? 'opencode-frontier';
      const fixProfileName: string =
        config.agent.phaseProfiles['fix-review']?.profile ?? 'opencode-frontier';
      const fixFallbackProfileName: string | undefined =
        config.agent.phaseProfiles['fix-review']?.fallbackProfile;
      const arbiterProfileName: string | undefined = resolveArbiterProfileName(
        config.agent.phaseProfiles,
      );

      const newestInvocationId = (runUuid: string): string => {
        const list = agentInvocationRepository.listByRun(RunId(runUuid));
        const last = list[list.length - 1];
        return last ? String(last.id) : '';
      };

      const runReview = async (
        ctx: StepContext,
        opts?: ReviewStepOptions | PostFixGateResult,
      ): Promise<ReviewStepResult> => {
        const opts_ = opts;
        const gateResult: PostFixGateResult | undefined =
          opts_ && 'outcome' in opts_ ? opts_ : opts_?.gateResult;
        const historyContext: string | undefined =
          opts_ && 'historyContext' in opts_ ? opts_.historyContext : undefined;
        const prevReviewedCommitSha: string | undefined =
          opts_ && 'prevReviewedCommitSha' in opts_ ? opts_.prevReviewedCommitSha : undefined;
        const mode = opts_ && 'mode' in opts_ ? opts_.mode : undefined;
        const unresolvedRecords =
          opts_ && 'unresolvedRecords' in opts_ ? opts_.unresolvedRecords : undefined;
        const dispositionHistory =
          opts_ && 'dispositionHistory' in opts_ ? opts_.dispositionHistory : undefined;
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
          ...(prevReviewedCommitSha ? { prevReviewedCommitSha } : {}),
          mode,
          unresolvedRecords,
          dispositionHistory,
        });
        writeFileSync(promptPath, reviewPrompt, 'utf-8');
        const startCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: ctx.cwd,
        })
          .toString()
          .trim();
        const isSemanticRetry = ctx.iterationIndex > 1;
        const result = await artifactAgent.invoke({
          profile: AgentProfileName(reviewProfileName),
          promptPath,
          expectedArtifacts: ['result.json', 'code-review.md'],
          cwd: ctx.cwd,
          runId: String(ctx.runId),
          repoId: ctx.repoId,
          phaseId: 'whole-pr-review',
          startCommitSha,
          metadata: {
            iteration: ctx.iterationIndex,
            invocation_type: isSemanticRetry ? 'semantic_retry' : 'initial',
            review_mode: mode,
            ...(prevReviewedCommitSha ? { review_base_identity: prevReviewedCommitSha } : {}),
            review_snapshot_kind: 'git',
            review_snapshot_identity: startCommitSha,
            review_dimensions: ['integration'],
            review_scope_source: 'review-fix',
          },
          ...(isSemanticRetry
            ? {
                retryIntent: {
                  normalizedPhase: 'whole-pr-review',
                  classification: 'semantic',
                  relevantArtifactPaths: ['result.json', 'code-review.md'],
                },
              }
            : {}),
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
              { artifacts: store, agent: artifactAgent, repair: structuredResultRepair },
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
          reviewedCommitSha: startCommitSha,
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
          deterministicDiagnostic?: string;
          attemptKind?: 'standard' | 'deterministic';
          reconciliationContext?: string;
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
          deterministicDiagnostic: opts.deterministicDiagnostic,
          reconciliationContext: opts.reconciliationContext,
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
        const verdict = patchedFixInv
          ? await readFixVerdict(patchedFixInv, {
              artifacts: store,
              agent: artifactAgent,
              repair: structuredResultRepair,
            })
          : { ok: false as const, detail: 'no invocation row' };
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
        await artifactStoreForRun(String(ctx.runId), ctx.cwd).write({
          runId: String(ctx.runId),
          phaseId: 'validate',
          relativePath: 'validation.result',
          contents: vr.passed ? 'passed\n' : 'failed\n',
        });
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
      const implementStepHistory = createImplementStepHistoryFilePort(persistingEventBusForLoop);

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

      const runWholePrArbiter = async (
        ctx: StepContext,
        reviewResult: ReviewStepResult,
        fixResult: FixStepResult,
      ): Promise<ArbiterResult> => {
        const store = artifactStoreForRun(String(ctx.runId), ctx.cwd);
        const newestInvocationId = (runUuid: string): string => {
          const list = agentInvocationRepository.listByRun(RunId(runUuid));
          const last = list[list.length - 1];
          return last ? String(last.id) : '';
        };

        const promptDir = join(baseTmpDir, 'review-fix-prompts');
        mkdirSync(promptDir, { recursive: true });
        const promptPath = join(
          promptDir,
          `whole-pr-arbiter-${String(ctx.runId)}-${ctx.iterationIndex}.md`,
        );

        const offendingFindings = reviewResult.offendingFindings ?? [];
        if (offendingFindings.length === 0) {
          return {
            outcome: 'insufficient_evidence',
            evidence: '',
            rationale: 'no offending findings in review result',
          };
        }

        const disputedFindings = await Promise.all(
          offendingFindings.map(async (f) => ({
            fingerprint: await fingerprintFinding('integration', f.severity, f.summary),
            severity: f.severity,
            summary: f.summary,
          })),
        );
        const fingerprints = disputedFindings.map((df) => df.fingerprint);

        const persistedDimensionStates = reviewStateRepository.listDimensionStates(
          String(ctx.runId),
          String(ctx.phaseId),
          String(ctx.phaseId),
        );
        const matchingDimensionState = persistedDimensionStates.find(
          (ds) => ds.dimension === 'integration',
        );
        const dispositionHistory =
          matchingDimensionState?.dispositionHistory.filter((h) =>
            fingerprints.includes(h.fingerprint),
          ) ?? [];

        const relevantExcerpts: string[] = [];
        if (reviewResult.excerpt) {
          relevantExcerpts.push(reviewResult.excerpt);
        }
        try {
          const codeReviewMd = await store.read(String(ctx.runId), 'code-review.md');
          for (const df of disputedFindings) {
            const searchStr = (df.summary ?? '').trim().toLowerCase();
            const fpIdx = codeReviewMd.toLowerCase().indexOf(searchStr);
            if (fpIdx !== -1) {
              const lines = codeReviewMd.split('\n');
              const linesBefore = codeReviewMd.slice(0, fpIdx).split('\n');
              const idx = linesBefore.length - 1;
              const start = Math.max(0, idx - 5);
              const end = Math.min(lines.length, idx + 15);
              relevantExcerpts.push(lines.slice(start, end).join('\n'));
            }
          }
        } catch (err) {
          console.warn(`[runWholePrArbiter] failed to read code-review.md:`, err);
          relevantExcerpts.push(
            `(Failed to read code-review.md: ${err instanceof Error ? err.message : String(err)})`,
          );
        }

        let fixDelta = '';
        if (fixResult.headBeforeFix) {
          try {
            fixDelta = execFileSync('git', ['diff', `${fixResult.headBeforeFix}..HEAD`], {
              cwd: ctx.cwd,
            }).toString();
            if (fixDelta.length > 3000) {
              const trimmed = fixDelta.slice(0, 3000);
              const lastNewline = trimmed.lastIndexOf('\n');
              fixDelta =
                (lastNewline > 0 ? trimmed.slice(0, lastNewline) : trimmed) +
                '\n[... diff truncated due to size limit ...]';
            }
          } catch (err) {
            console.warn(`[runWholePrArbiter] failed to execute git diff:`, err);
            fixDelta = `(Failed to execute git diff: ${err instanceof Error ? err.message : String(err)})`;
          }
        }

        const arbiterPrompt = buildWholePrArbiterPrompt({
          cwd: ctx.cwd,
          repoId: ctx.repoId,
          disputedFindings,
          dispositionHistory,
          relevantExcerpts,
          fixDelta,
          fixRebuttal: fixResult.rebuttal ?? '',
        });

        writeFileSync(promptPath, arbiterPrompt, 'utf-8');

        const startCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ctx.cwd })
          .toString()
          .trim();
        const profile = arbiterProfileName || 'opencode-frontier';

        await artifactAgent.invoke({
          profile: AgentProfileName(profile),
          promptPath,
          expectedArtifacts: ['result.json'],
          cwd: ctx.cwd,
          runId: String(ctx.runId),
          repoId: ctx.repoId,
          phaseId: 'arbiter',
          startCommitSha,
          metadata: {
            iteration: ctx.iterationIndex,
            invocation_type: 'initial',
            review_mode: 'integration_full',
            review_snapshot_kind: 'git',
            review_snapshot_identity: startCommitSha,
            review_dimensions: ['integration'],
            review_scope_source: 'review-fix',
          },
        });

        const invocationId = newestInvocationId(String(ctx.runId));
        const inv = agentInvocationRepository.findById(AgentInvocationId(invocationId));
        const patchedInv = inv?.resultJsonPath
          ? inv
          : inv
            ? { ...inv, resultJsonPath: 'result.json' }
            : inv;

        if (!patchedInv) {
          return {
            outcome: 'insufficient_evidence',
            evidence: '',
            rationale: 'no arbiter invocation row',
          };
        }

        const verdict = await extractResult({
          invocation: patchedInv,
          ports: { artifacts: store, agent: artifactAgent, repair: structuredResultRepair },
        });

        if (!verdict.ok) {
          return {
            outcome: 'insufficient_evidence',
            evidence: '',
            rationale: `arbiter result.json unparseable: ${verdict.detail}`,
          };
        }

        const parsed = arbiterResultSchema.safeParse(verdict.result);
        if (!parsed.success) {
          return {
            outcome: 'insufficient_evidence',
            evidence: '',
            rationale: `Zod parse error: ${parsed.error.message}`,
          };
        }

        return parsed.data as ArbiterResult;
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
        git: gitAdapter,
        loopHistory,
        findingEvidenceInspector: createFindingEvidenceInspector(),
        unfoundedPingPongLimit: config.phases.reviewFix.unfoundedPingPongLimit,
        reviewStateRepository,
        runArbiter: runWholePrArbiter,
        options: {
          endOnReview: config.phases.reviewFix.endOnReview,
          deltaScopedReReview: config.phases.reviewFix.deltaScopedReReview,
          trendAwareExit: {
            enabled: config.phases.reviewFix.trendAwareExit.enabled,
            mode: config.phases.reviewFix.trendAwareExit.mode,
            window: config.phases.reviewFix.trendAwareExit.window,
          },
        },
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
        },
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
      const implementFallbackProfileName: string | undefined =
        config.agent.phaseProfiles['implement']?.fallbackProfile;
      const specReviewProfileName: string =
        config.agent.phaseProfiles['spec-review']?.profile ?? 'opencode-frontier';
      const qualityReviewProfileName: string =
        config.agent.phaseProfiles['quality-review']?.profile ?? 'pi-qwen-local';
      const implFixProfileName: string =
        config.agent.phaseProfiles['fix-review']?.profile ?? 'opencode-frontier';
      const implFixFallbackProfileName: string | undefined =
        config.agent.phaseProfiles['fix-review']?.fallbackProfile;
      // arbiterProfileName is declared earlier (the mode-aware arbiter rework
      // needs it before this block); reference it rather than re-declaring.
      const terminalFixProfileName: string | undefined =
        config.agent.phaseProfiles['terminal-fix']?.profile ?? arbiterProfileName;

      const makeArtifactStore = (runUuid: string, cwd: string): ArtifactStore =>
        artifactStoreForRun(runUuid, cwd);

      const buildContext = (run: Run): PhaseHandlerContext => {
        const repo = registryBackedRepo.findById(run.repoId);
        const repoRootPath = repo ? repo.localBasePath : targetRoot;
        const repoFullName = repo ? repo.fullName : (resolvedRepoFullName ?? '');
        const defaultBranch = repo ? repo.defaultBranch : resolvedDefaultBranch;

        const cwd = join(repoRootPath, '.ai-worktrees', `issue-${run.issueNumber}`);
        const startCommitSha = runRepository.findByUuid(run.uuid)?.startCommitSha;
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
            events: eventBus,
            now: () => new Date(),
          },
          {
            promptsRoot: join(opts.repoRoot, 'prompts'),
            expectedBranch: `ai/issue-${run.issueNumber}`,
            baseBranch: run.baseBranch ?? opts.baseBranch ?? defaultBranch,
            ...(startCommitSha ? { startCommitSha } : {}),
          },
        );
      };
      buildRunContext = buildContext;

      const runImplement = async (
        ctx: StepLoopContext & { manifest: TaskManifest; planMd: string },
        opts?: ImplementStepOptions,
      ) => {
        const fallbackProfile = implementFallbackProfileName;
        const primaryProfile = implementProfileName;
        const profile = opts?.useFallback && fallbackProfile ? fallbackProfile : primaryProfile;

        const run = runRepository.findByUuid(String(ctx.runId));
        const runDir = run?.displayId ?? String(ctx.runId);
        const issueNumber = run?.issueNumber ?? 0;
        const branchName = `ai/issue-${issueNumber}`;
        const artifacts = artifactStoreForRun(String(ctx.runId), ctx.cwd);

        const manifest = ctx.manifest;
        const planMd = ctx.planMd;

        let designMd: string | undefined;
        try {
          designMd = await artifacts.read(String(ctx.runId), 'design.md');
        } catch {
          // design.md is optional
        }

        const dependencyLogs = new Map<number, string>();
        if (manifest.version === 2) {
          const task = manifest.tasks.find((t) => t.n === ctx.stepIndex);
          if (task && task.depends_on) {
            for (const depId of task.depends_on) {
              try {
                const log = await artifacts.read(
                  String(ctx.runId),
                  `implementation-log-task-${depId}.md`,
                );
                dependencyLogs.set(depId, log);
              } catch {
                // missing dependency log is non-fatal for context generation
              }
            }
          }
        }

        const generator = new TaskContextGenerator();
        const task = manifest.tasks.find((t) => t.n === ctx.stepIndex)!;
        const contextResult = generator.generate({
          task,
          manifest,
          planMd,
          designMd: designMd ?? '',
          dependencyLogs,
          workspaceConstraints: WORKSPACE_CONSTRAINTS,
          cwd: ctx.cwd,
          repoId: ctx.repoId,
          branchName,
          startCommitSha: run?.startCommitSha ?? '',
        });

        const taskContext = contextResult.content;
        // Write task-context.md as an artifact for auditability
        try {
          await artifacts.write({
            runId: String(ctx.runId),
            phaseId: 'implement',
            relativePath: `task-context-step-${ctx.stepIndex}.md`,
            contents: taskContext,
          });
        } catch {
          /* best-effort */
        }

        const promptDir = join(baseTmpDir, 'implement-step-prompts');
        mkdirSync(promptDir, { recursive: true });
        const promptPath = join(promptDir, `implement-${String(ctx.runId)}-${ctx.stepIndex}.md`);
        const implementPrompt = buildImplementPrompt(
          ctx,
          taskContext,
          branchName,
          opts?.typecheckErrors,
        );
        writeFileSync(promptPath, implementPrompt, 'utf-8');
        const startCommitSha = resolveStartCommitSha(ctx.cwd, String(ctx.runId));
        const isDeterministic = !!opts?.typecheckErrors;
        const isSemanticRetry = ctx.iterationIndex > 1 && !opts?.useFallback && !isDeterministic;
        let result;
        try {
          result = await artifactAgent.invoke({
            profile: AgentProfileName(profile),
            promptPath,
            expectedArtifacts: ['implementation-log.md'],
            cwd: ctx.cwd,
            runId: String(ctx.runId),
            repoId: ctx.repoId,
            phaseId: 'implement',
            startCommitSha,
            ...(opts?.useFallback && opts.previousInvocationId
              ? {
                  fallbackOfInvocationId: AgentInvocationId(opts.previousInvocationId),
                  fallbackReason: 'use_case_escalation',
                  metadata: {
                    implementation_task_number: ctx.stepIndex,
                    iteration: ctx.iterationIndex,
                    invocation_type: 'fallback',
                  },
                }
              : {
                  metadata: {
                    implementation_task_number: ctx.stepIndex,
                    iteration: ctx.iterationIndex,
                    invocation_type: isDeterministic
                      ? 'deterministic_fix'
                      : isSemanticRetry
                        ? 'semantic_retry'
                        : 'initial',
                  },
                  ...(isSemanticRetry
                    ? {
                        retryIntent: {
                          normalizedPhase: 'implement',
                          classification: 'semantic',
                          relevantArtifactPaths: ['implementation-log.md'],
                        },
                      }
                    : {}),
                }),
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

        // No-op re-verification safety net (#610): if the only reason this
        // invocation is a contract violation is the missing
        // implementation-log.md, and the agent declared the step already
        // done with no new work to do, synthesize a minimal log from
        // verifiable state (git + transcript) instead of failing the step.
        // This MUST happen here, inside runImplement, and return 'success'
        // so ImplementStepLoop proceeds through the typecheck/spec-review/
        // quality-review gates below exactly as if the agent had written the
        // log itself — recovering the artifact must never let unreviewed or
        // untypechecked work skip those gates.
        let recoveredByExistingGuard = false;
        let agentOutcome = result.outcome;
        if (result.outcome === 'contract_violation') {
          const expectedArtifacts = ['implementation-log.md'];
          const missing = expectedArtifacts.filter((a) => !existsSync(join(ctx.cwd, a)));
          if (missing.includes('implementation-log.md')) {
            const stdoutTail = await readTail(result.stdoutPath);
            const stderrTail = await readTail(result.stderrPath);
            const guardInput: ImplementArtifactGuardInput = {
              runId: String(ctx.runId),
              cwd: ctx.cwd,
              phaseId: 'implement',
              stepIndex: ctx.stepIndex,
              expectedArtifacts,
              invocationEnd: {
                startCommitSha,
                ...(result.endCommitSha !== undefined ? { endCommitSha: result.endCommitSha } : {}),
                durationMs: result.durationMs,
                outcome: result.outcome,
              },
              invocationTranscript: {
                stdoutTail,
                stderrTail,
                ...(result.resultJsonPath !== undefined
                  ? { resultJsonPath: result.resultJsonPath }
                  : {}),
              },
            };
            try {
              const guardOutcome =
                await implementArtifactGuard.synthesizeMissingArtifactsIfDoneDeclared(guardInput);
              const actuallyRecovered = guardOutcome.synthesized.filter(
                (s) =>
                  s.reason === 'no_op_reverification_done_declared' ||
                  s.reason === 'already_present',
              );
              if (actuallyRecovered.length > 0) {
                agentOutcome = 'success';
                recoveredByExistingGuard = true;
                agentInvocationRepository.update(AgentInvocationId(invocationId), {
                  outcome: 'success',
                  contractViolations: [],
                });
                for (const s of guardOutcome.synthesized) {
                  persistingEventBusForLoop.publish(String(ctx.runId), {
                    runId: String(ctx.runId),
                    level: 'warn',
                    type: 'step.artifact.synthesized',
                    message: `synthesized ${s.artifact}`,
                    timestamp: new Date().toISOString(),
                    metadata: {
                      phaseId: 'implement',
                      stepIndex: ctx.stepIndex,
                      artifact: s.artifact,
                      reason: s.reason,
                    },
                  });
                }
              } else {
                persistingEventBusForLoop.publish(String(ctx.runId), {
                  runId: String(ctx.runId),
                  level: 'info',
                  type: 'step.artifact.not_synthesized',
                  message: 'guard policy not satisfied on no-op re-verification',
                  timestamp: new Date().toISOString(),
                  metadata: {
                    phaseId: 'implement',
                    stepIndex: ctx.stepIndex,
                    artifact: 'implementation-log.md',
                  },
                });
              }
            } catch (e) {
              persistingEventBusForLoop.publish(String(ctx.runId), {
                runId: String(ctx.runId),
                level: 'warn',
                type: 'step.artifact.synthesized',
                message: `guard threw: ${e instanceof Error ? e.message : String(e)}`,
                timestamp: new Date().toISOString(),
                metadata: {
                  phaseId: 'implement',
                  stepIndex: ctx.stepIndex,
                  artifact: 'implementation-log.md',
                  reason: 'guard_threw',
                },
              });
            }
          }
        }

        // Prose-artifact synthesis (#640): if the existing no-op guard did NOT
        // recover (D4.a) and the worktree still has an unsynthesized prose
        // artifact (D4.c — HEAD advanced), try to lift the summary out of the
        // transcript tail via a one-shot result-writer invocation. On success
        // the primary row's outcome becomes 'success' and the synthesis row
        // links back via fallbackOfInvocationId. On any failure, the original
        // contract_violation / MISSING_REQUIRED_ARTIFACT outcome stays and
        // the router fallback fires unchanged.
        if (agentOutcome === 'contract_violation' && !recoveredByExistingGuard) {
          const expectedSynthesisArtifacts = ['implementation-log.md'];
          const missingProse = expectedSynthesisArtifacts.filter(
            (a) => !existsSync(join(ctx.cwd, a)),
          );
          if (missingProse.length === 1 && missingProse[0] !== undefined) {
            const synthInput: SynthesizeFromTranscriptInput = {
              runId: String(ctx.runId),
              cwd: ctx.cwd,
              phaseId: 'implement',
              stepIndex: ctx.stepIndex,
              primaryInvocation: {
                id: AgentInvocationId(invocationId),
                stdoutPath: result.stdoutPath,
                stderrPath: result.stderrPath,
              },
              missingArtifact: missingProse[0],
              startCommitSha,
              endCommitSha: result.endCommitSha ?? startCommitSha,
              primaryExitCode: result.exitCode,
              workingTreeDirty: false,
            };
            try {
              const synth = await synthesizeFromTranscript.synthesizeFromTranscript(synthInput);
              if (synth.outcome === 'synthesized') {
                agentOutcome = 'success';
                agentInvocationRepository.update(AgentInvocationId(invocationId), {
                  outcome: 'success',
                  contractViolations: [],
                });
              }
            } catch (e) {
              persistingEventBusForLoop.publish(String(ctx.runId), {
                runId: String(ctx.runId),
                level: 'warn',
                type: 'artifact.synthesis_failed',
                message: `synthesis guard threw: ${e instanceof Error ? e.message : String(e)}`,
                timestamp: new Date().toISOString(),
                metadata: {
                  phaseId: 'implement',
                  stepIndex: ctx.stepIndex,
                  artifact: missingProse[0],
                  reason: 'guard_threw',
                },
              });
            }
          }
        }

        return {
          invocationId,
          agentOutcome,
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

      // Archive a step invocation's result.json under a phase-segregated
      // durable name so later phases can't overwrite it (#661). Durable-only
      // on purpose: writing through the artifact store would also drop the
      // copy into the git worktree, where fix agents have committed stray
      // orchestrator files before.
      const archiveStepResultDurably = (
        ctx: StepLoopContext,
        resultJsonPath: string,
        artifactName: string,
        scope?: { mode: string; startCommitSha: string },
      ): void => {
        const runDir = runRepository.findByUuid(String(ctx.runId))?.displayId ?? String(ctx.runId);
        const destination = join(runsDir, runDir, 'phase-artifacts', artifactName);
        try {
          mkdirSync(dirname(destination), { recursive: true });
          copyFileSync(join(ctx.cwd, resultJsonPath), destination);
        } catch (err) {
          persistingEventBusForLoop.publish(String(ctx.runId), {
            runId: String(ctx.runId),
            level: 'warn',
            type: 'artifact.copy_failed',
            message: `Failed to copy artifact: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: new Date().toISOString(),
            metadata: { source: join(ctx.cwd, resultJsonPath), destination },
          });
        }
        if (scope) {
          const modeSpecificName = `${artifactName.replace('.json', '')}.${scope.mode}.${scope.startCommitSha}.json`;
          const modeSpecificDestination = join(
            runsDir,
            runDir,
            'phase-artifacts',
            modeSpecificName,
          );
          try {
            mkdirSync(dirname(modeSpecificDestination), { recursive: true });
            copyFileSync(join(ctx.cwd, resultJsonPath), modeSpecificDestination);
          } catch (err) {
            persistingEventBusForLoop.publish(String(ctx.runId), {
              runId: String(ctx.runId),
              level: 'warn',
              type: 'artifact.copy_failed',
              message: `Failed to copy artifact (mode-specific): ${err instanceof Error ? err.message : String(err)}`,
              timestamp: new Date().toISOString(),
              metadata: {
                source: join(ctx.cwd, resultJsonPath),
                destination: modeSpecificDestination,
              },
            });
          }
        }
      };

      const runSpecReview = async (
        ctx: StepLoopContext,
        tcResult: TypecheckResult,
        scope: {
          mode: 'initial_full' | 'intermediate_delta' | 'final_full';
          dimensions?: Array<'spec' | 'quality'>;
        },
      ) => {
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
        const reviewPrompt = buildSpecReviewPrompt({
          ctx: { stepIndex: ctx.stepIndex, stepTitle: ctx.stepTitle, cwd: ctx.cwd },
          typecheckSection,
          implReport,
          scope,
        });
        writeFileSync(promptPath, reviewPrompt, 'utf-8');
        const startCommitSha = resolveStartCommitSha(ctx.cwd, String(ctx.runId));
        const isSemanticRetry = ctx.iterationIndex > 1;
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
            metadata: {
              implementation_task_number: ctx.stepIndex,
              iteration: ctx.iterationIndex,
              invocation_type: isSemanticRetry ? 'semantic_retry' : 'initial',
              review_mode: scope.mode,
              review_dimensions: scope.dimensions ?? ['spec'],
              review_scope_source: 'implement-step',
              review_snapshot_kind: 'git',
              review_snapshot_identity: startCommitSha,
              review_base_identity: undefined,
            },
            ...(isSemanticRetry
              ? {
                  retryIntent: {
                    normalizedPhase: 'spec-review',
                    classification: 'semantic',
                    relevantArtifactPaths: ['result.json'],
                  },
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
            metadata: { phaseId: 'spec-review', stepIndex: ctx.stepIndex },
          });
          return { invocationId: '', agentOutcome: 'failed' as const };
        }
        const postInvokeHead = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: ctx.cwd,
          encoding: 'utf-8',
        }).trim();
        if (postInvokeHead !== startCommitSha) {
          persistingEventBusForLoop.publish(String(ctx.runId), {
            runId: String(ctx.runId),
            level: 'warn',
            type: 'review.stale_head',
            message: `HEAD changed during spec-review invocation (${startCommitSha} -> ${postInvokeHead})`,
            timestamp: new Date().toISOString(),
            metadata: {
              phaseId: 'spec-review',
              stepIndex: ctx.stepIndex,
              startCommitSha,
              postInvokeHead,
            },
          });
          return { invocationId: '', agentOutcome: 'failed' as const };
        }
        const invocationId = newestInvocationId(String(ctx.runId));
        const inv = agentInvocationRepository.findById(AgentInvocationId(invocationId));
        if (!inv) return { invocationId, agentOutcome: result.outcome };
        const patched = inv.resultJsonPath ? inv : { ...inv, resultJsonPath: 'result.json' };
        archiveStepResultDurably(
          ctx,
          patched.resultJsonPath ?? 'result.json',
          SPEC_REVIEW_RESULT_ARTIFACT,
          { mode: scope.mode, startCommitSha },
        );
        const verdict = await readReviewVerdict(
          patched,
          { artifacts, agent: artifactAgent, repair: structuredResultRepair },
          { blockOnSeverity: config.phases.reviewFix.blockOnSeverity },
        );
        if (!verdict.ok) return { invocationId, agentOutcome: 'contract_violation' as const };
        return {
          invocationId,
          agentOutcome: 'success' as const,
          verdict: verdict.verdict,
          ...(verdict.ok && verdict.offendingFindings
            ? { findings: verdict.offendingFindings }
            : {}),
        };
      };

      const runQualityReview = async (
        ctx: StepLoopContext,
        tcResult: TypecheckResult,
        scope: {
          mode: 'initial_full' | 'intermediate_delta' | 'final_full';
          dimensions?: Array<'spec' | 'quality'>;
        },
      ) => {
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

        const reviewPrompt = buildQualityReviewPrompt({
          ctx: { stepIndex: ctx.stepIndex, stepTitle: ctx.stepTitle, cwd: ctx.cwd },
          typecheckSection,
          scope,
        });
        writeFileSync(promptPath, reviewPrompt, 'utf-8');
        const startCommitSha = resolveStartCommitSha(ctx.cwd, String(ctx.runId));
        const isSemanticRetry = ctx.iterationIndex > 1;
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
            metadata: {
              implementation_task_number: ctx.stepIndex,
              iteration: ctx.iterationIndex,
              invocation_type: isSemanticRetry ? 'semantic_retry' : 'initial',
              review_mode: scope.mode,
              review_dimensions: scope.dimensions ?? ['quality'],
              review_scope_source: 'implement-step',
              review_snapshot_kind: 'git',
              review_snapshot_identity: startCommitSha,
              review_base_identity: undefined,
            },
            ...(isSemanticRetry
              ? {
                  retryIntent: {
                    normalizedPhase: 'quality-review',
                    classification: 'semantic',
                    relevantArtifactPaths: ['result.json'],
                  },
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
            metadata: { phaseId: 'quality-review', stepIndex: ctx.stepIndex },
          });
          return { invocationId: '', agentOutcome: 'failed' as const };
        }
        const postInvokeHead = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: ctx.cwd,
          encoding: 'utf-8',
        }).trim();
        if (postInvokeHead !== startCommitSha) {
          persistingEventBusForLoop.publish(String(ctx.runId), {
            runId: String(ctx.runId),
            level: 'warn',
            type: 'review.stale_head',
            message: `HEAD changed during quality-review invocation (${startCommitSha} -> ${postInvokeHead})`,
            timestamp: new Date().toISOString(),
            metadata: {
              phaseId: 'quality-review',
              stepIndex: ctx.stepIndex,
              startCommitSha,
              postInvokeHead,
            },
          });
          return { invocationId: '', agentOutcome: 'failed' as const };
        }
        const invocationId = newestInvocationId(String(ctx.runId));
        const inv = agentInvocationRepository.findById(AgentInvocationId(invocationId));
        if (!inv) return { invocationId, agentOutcome: result.outcome };
        const patched = inv.resultJsonPath ? inv : { ...inv, resultJsonPath: 'result.json' };
        archiveStepResultDurably(
          ctx,
          patched.resultJsonPath ?? 'result.json',
          QUALITY_REVIEW_RESULT_ARTIFACT,
          { mode: scope.mode, startCommitSha },
        );
        const artifacts = artifactStoreForRun(String(ctx.runId), ctx.cwd);
        const verdict = await readReviewVerdict(
          patched,
          { artifacts, agent: artifactAgent, repair: structuredResultRepair },
          { blockOnSeverity: config.phases.reviewFix.blockOnSeverity },
        );
        if (!verdict.ok) return { invocationId, agentOutcome: 'contract_violation' as const };
        return {
          invocationId,
          agentOutcome: 'success' as const,
          verdict: verdict.verdict,
          ...(verdict.ok && verdict.offendingFindings
            ? { findings: verdict.offendingFindings }
            : {}),
        };
      };

      const implRunFix = async (ctx: StepLoopContext, opts: ImplementFixStepOptions) => {
        const promptDir = join(baseTmpDir, 'implement-step-prompts');
        mkdirSync(promptDir, { recursive: true });
        const promptPath = join(
          promptDir,
          `fix-${String(ctx.runId)}-${ctx.stepIndex}-${ctx.iterationIndex}.md`,
        );
        // Terminal escalation must actually run on the terminal profile —
        // routing only on useFallback here silently re-runs the economy fixer
        // that just exhausted the loop (#763; same seam bug class as #670).
        const profile =
          opts.isTerminalFix && terminalFixProfileName
            ? terminalFixProfileName
            : opts.useFallback && implFixFallbackProfileName
              ? implFixFallbackProfileName
              : implFixProfileName;
        const artifacts = artifactStoreForRun(String(ctx.runId), ctx.cwd);
        const fixPrompt = await buildImplementStepFixPrompt(artifacts, String(ctx.runId), {
          cwd: ctx.cwd,
          stepIndex: ctx.stepIndex,
          stepTitle: ctx.stepTitle,
          ...(opts.reconciliationContext !== undefined
            ? { reconciliationContext: opts.reconciliationContext }
            : {}),
          ...(opts.historyContext !== undefined ? { historyContext: opts.historyContext } : {}),
          ...(opts.typecheckErrors !== undefined ? { typecheckErrors: opts.typecheckErrors } : {}),
          ...(opts.isTerminalFix ? { isTerminalFix: true } : {}),
          ...(opts.holisticFindings !== undefined
            ? { holisticFindings: opts.holisticFindings }
            : {}),
        });
        writeFileSync(promptPath, fixPrompt, 'utf-8');
        const startCommitSha = resolveStartCommitSha(ctx.cwd, String(ctx.runId));
        const isDeterministic = !!opts.typecheckErrors;
        const isSemanticRetry = ctx.iterationIndex > 1 && !isDeterministic;
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
                  metadata: {
                    implementation_task_number: ctx.stepIndex,
                    iteration: ctx.iterationIndex,
                    invocation_type: 'fallback',
                  },
                }
              : {
                  metadata: {
                    implementation_task_number: ctx.stepIndex,
                    iteration: ctx.iterationIndex,
                    invocation_type: isDeterministic
                      ? 'deterministic_fix'
                      : isSemanticRetry
                        ? 'semantic_retry'
                        : 'initial',
                  },
                  ...(isSemanticRetry
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
        archiveStepResultDurably(ctx, patched.resultJsonPath ?? 'result.json', FIX_RESULT_ARTIFACT);
        const fixVerdict = await readFixVerdict(patched, {
          artifacts,
          agent: artifactAgent,
          repair: structuredResultRepair,
        });
        return {
          invocationId,
          agentOutcome: fixVerdict.ok ? ('success' as const) : ('contract_violation' as const),
          ...(fixVerdict.ok ? { verdict: fixVerdict.verdict } : {}),
          ...(fixVerdict.ok && fixVerdict.rebuttal ? { rebuttal: fixVerdict.rebuttal } : {}),
          headBeforeFix: startCommitSha,
        };
      };

      type LoopArbiterResult = Awaited<ReturnType<Required<ImplementStepLoopDeps>['runArbiter']>>;

      const runArbiter: ImplementStepLoopDeps['runArbiter'] | undefined = arbiterProfileName
        ? async (ctx, tcResult, fixResult): Promise<LoopArbiterResult> => {
            const promptDir = join(baseTmpDir, 'implement-step-prompts');
            mkdirSync(promptDir, { recursive: true });
            const promptPath = join(
              promptDir,
              `arbiter-${String(ctx.runId)}-${ctx.stepIndex}-${ctx.iterationIndex}.md`,
            );
            const artifacts = artifactStoreForRun(String(ctx.runId), ctx.cwd);

            const { specExcerpt, qualityExcerpt } = await readArbiterExcerpts(
              artifacts,
              String(ctx.runId),
            );

            let taskBody = '';
            try {
              const plan = await artifacts.read(String(ctx.runId), 'plan.md');
              const parsed = parseTaskManifest(
                await artifacts.read(String(ctx.runId), 'task-manifest.json'),
              );
              const titleMatch =
                parsed.success && parsed.manifest.tasks.find((t) => t.n === ctx.stepIndex)?.title;
              const extracted = extractTaskBody(plan, {
                taskNumber: ctx.stepIndex,
                ...(titleMatch ? { title: titleMatch } : {}),
              });
              taskBody = extracted.ok ? extracted.body : '';
            } catch {
              taskBody = '';
            }

            let fixDelta = '';
            try {
              if (fixResult.headBeforeFix) {
                fixDelta = execFileSync(
                  'git',
                  ['diff', '--unified=3', `${fixResult.headBeforeFix}..HEAD`],
                  { cwd: ctx.cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
                );
              }
            } catch {
              fixDelta = '';
            }

            let disputedFinding: {
              fingerprint: string;
              severity: string;
              summary: string;
              file?: string;
              suggested_fix?: string;
            } = { fingerprint: 'unknown', severity: 'P1', summary: 'Review finding' };
            let dispositionHistory: Array<{
              fingerprint: string;
              disposition: 'open' | 'addressed' | 'rebutted' | 'settled' | 'recurred';
              reason?: string;
            }> = [];
            const parseExcerptForFinding = (excerpt: string) => {
              if (!excerpt) return null;
              try {
                const parsed = JSON.parse(excerpt);
                if (parsed.findings && parsed.findings.length > 0) {
                  return parsed.findings[0];
                }
              } catch {
                return null;
              }
              return null;
            };
            const specFinding = parseExcerptForFinding(specExcerpt);
            const qualityFinding = parseExcerptForFinding(qualityExcerpt);
            const findingToUse = specFinding ?? qualityFinding;
            if (!findingToUse) {
              return {
                outcome: 'insufficient_evidence' as const,
                evidence: '',
                rationale:
                  'arbiter could not locate a disputed finding in spec-review or quality-review result artifacts',
              };
            }
            const persistedDimensionStates = reviewStateRepository.listDimensionStates(
              String(ctx.runId),
              'implement',
              String(ctx.stepIndex),
            );
            const matchingDimensionState = persistedDimensionStates.find((ds) =>
              ds.unresolvedRecords.some(
                (r) => r.summary === findingToUse.summary && r.severity === findingToUse.severity,
              ),
            );
            const matchingRecord = matchingDimensionState?.unresolvedRecords.find(
              (r) => r.summary === findingToUse.summary && r.severity === findingToUse.severity,
            );
            disputedFinding = {
              fingerprint: matchingRecord?.fingerprint ?? `fp-${Date.now()}`,
              severity: findingToUse.severity || 'P1',
              summary: findingToUse.summary || 'Unknown finding',
              ...(findingToUse.file ? { file: findingToUse.file } : {}),
              ...(findingToUse.suggested_fix ? { suggested_fix: findingToUse.suggested_fix } : {}),
            };
            dispositionHistory =
              matchingDimensionState?.dispositionHistory.filter(
                (dh) => dh.fingerprint === disputedFinding.fingerprint,
              ) ?? [];

            const arbiterInputs: {
              tcResult: typeof tcResult;
              disputedFinding: typeof disputedFinding;
              dispositionHistory: typeof dispositionHistory;
              fixRebuttal: string;
              taskBody: string;
              deterministicDiagnostics?: string;
              fixDelta: string;
            } = {
              tcResult,
              disputedFinding,
              dispositionHistory,
              fixRebuttal: fixResult.rebuttal ?? '',
              taskBody,
              fixDelta,
            };
            if (tcResult.outcome === 'fail' && tcResult.output) {
              arbiterInputs.deterministicDiagnostics = tcResult.output;
            }

            const arbiterPrompt = buildArbiterPrompt(
              { stepIndex: ctx.stepIndex, stepTitle: ctx.stepTitle, cwd: ctx.cwd },
              arbiterInputs,
            );
            writeFileSync(promptPath, arbiterPrompt, 'utf-8');

            const startCommitSha = (() => {
              try {
                return execFileSync('git', ['rev-parse', 'HEAD'], {
                  cwd: ctx.cwd,
                  encoding: 'utf-8',
                }).trim();
              } catch {
                return resolveStartCommitSha(ctx.cwd, String(ctx.runId));
              }
            })();

            try {
              await artifactAgent.invoke({
                profile: AgentProfileName(arbiterProfileName),
                promptPath,
                expectedArtifacts: ['result.json'],
                cwd: ctx.cwd,
                runId: String(ctx.runId),
                repoId: ctx.repoId,
                phaseId: 'arbiter',
                startCommitSha,
                metadata: {
                  implementation_task_number: ctx.stepIndex,
                  iteration: ctx.iterationIndex,
                  invocation_type: 'initial',
                },
              });
            } catch (err) {
              persistingEventBusForLoop.publish(String(ctx.runId), {
                runId: String(ctx.runId),
                level: 'error',
                type: 'agent.invoke_failed',
                message: `Arbiter invocation failed: ${err instanceof Error ? err.message : String(err)}`,
                timestamp: new Date().toISOString(),
                metadata: { phaseId: 'arbiter', stepIndex: ctx.stepIndex },
              });
              return {
                outcome: 'insufficient_evidence',
                evidence: '',
                rationale: `arbiter invocation threw: ${err instanceof Error ? err.message : String(err)}`,
              };
            }

            const invocationId = newestInvocationId(String(ctx.runId));
            const inv = agentInvocationRepository.findById(AgentInvocationId(invocationId));
            if (!inv) {
              return {
                outcome: 'insufficient_evidence',
                evidence: '',
                rationale: `arbiter invocation produced no row`,
              };
            }
            const patched = inv.resultJsonPath ? inv : { ...inv, resultJsonPath: 'result.json' };
            const verdict = await extractResult({
              invocation: patched,
              ports: { artifacts, agent: artifactAgent, repair: structuredResultRepair },
            });
            if (!verdict.ok) {
              return {
                outcome: 'insufficient_evidence',
                evidence: '',
                rationale: `arbiter result.json unparseable: ${verdict.detail}`,
              };
            }
            return arbiterResultSchema.parse(verdict.result) as LoopArbiterResult;
          }
        : undefined;

      type ImplementStepFinalReviewArbiterResult = Awaited<
        ReturnType<Required<ImplementStepLoopDeps>['runFinalReviewArbiter']>
      >;

      const implementStepFinalReviewRunArbiter:
        | ImplementStepLoopDeps['runFinalReviewArbiter']
        | undefined = arbiterProfileName
        ? async (
            ctx,
            _tcResult,
            _specReview,
            _qualityReview,
          ): Promise<ImplementStepFinalReviewArbiterResult> => {
            // Note: _tcResult, _specReview, and _qualityReview are accepted to satisfy the port signature,
            // but are ignored here because the prompt builder reads their full JSON/markdown artifacts
            // from the durable artifact store directly to preserve raw formatting/structure.
            // Also, the caller loop already asserts that typecheck passed before invoking this arbiter.

            const promptDir = join(baseTmpDir, 'implement-step-prompts');
            mkdirSync(promptDir, { recursive: true });
            const promptPath = join(
              promptDir,
              `implement-step-final-review-arbiter-${String(ctx.runId)}-${ctx.stepIndex}-${ctx.iterationIndex}.md`,
            );
            const artifacts = artifactStoreForRun(String(ctx.runId), ctx.cwd);

            const { specExcerpt, qualityExcerpt } = await readImplementStepFinalReviewExcerpts(
              artifacts,
              String(ctx.runId),
            );

            let taskBody = '';
            try {
              const plan = await artifacts.read(String(ctx.runId), 'plan.md');
              const parsed = parseTaskManifest(
                await artifacts.read(String(ctx.runId), 'task-manifest.json'),
              );
              const titleMatch =
                parsed.success && parsed.manifest.tasks.find((t) => t.n === ctx.stepIndex)?.title;
              const extracted = extractTaskBody(plan, {
                taskNumber: ctx.stepIndex,
                ...(titleMatch ? { title: titleMatch } : {}),
              });
              taskBody = extracted.ok ? extracted.body : '';
            } catch {
              taskBody = '';
            }

            const arbiterPrompt = buildImplementStepFinalReviewArbiterPrompt(
              { stepIndex: ctx.stepIndex, stepTitle: ctx.stepTitle, cwd: ctx.cwd },
              { specExcerpt, qualityExcerpt, taskBody },
            );
            writeFileSync(promptPath, arbiterPrompt, 'utf-8');

            const startCommitSha = (() => {
              try {
                return execFileSync('git', ['rev-parse', 'HEAD'], {
                  cwd: ctx.cwd,
                  encoding: 'utf-8',
                }).trim();
              } catch {
                return resolveStartCommitSha(ctx.cwd, String(ctx.runId));
              }
            })();

            try {
              rmSync(join(ctx.cwd, 'result.json'), { force: true });
            } catch {}

            try {
              await artifactAgent.invoke({
                profile: AgentProfileName(arbiterProfileName),
                promptPath,
                expectedArtifacts: ['result.json'],
                cwd: ctx.cwd,
                runId: String(ctx.runId),
                repoId: ctx.repoId,
                phaseId: 'implement-final-review-arbiter',
                startCommitSha,
                metadata: {
                  implementation_task_number: ctx.stepIndex,
                  iteration: ctx.iterationIndex,
                  invocation_type: 'initial',
                },
              });
            } catch (err) {
              persistingEventBusForLoop.publish(String(ctx.runId), {
                runId: String(ctx.runId),
                level: 'error',
                type: 'agent.invoke_failed',
                message: `Arbiter invocation failed: ${err instanceof Error ? err.message : String(err)}`,
                timestamp: new Date().toISOString(),
                metadata: { phaseId: 'implement-final-review-arbiter', stepIndex: ctx.stepIndex },
              });
              return {
                outcome: 'insufficient_evidence',
                evidence: '',
                rationale: `arbiter invocation threw: ${err instanceof Error ? err.message : String(err)}`,
              };
            }

            const invocationId = newestInvocationId(String(ctx.runId));
            const inv = agentInvocationRepository.findById(AgentInvocationId(invocationId));
            if (!inv) {
              return {
                outcome: 'insufficient_evidence',
                evidence: '',
                rationale: `arbiter invocation produced no row`,
              };
            }
            const patched = inv.resultJsonPath ? inv : { ...inv, resultJsonPath: 'result.json' };
            const verdict = await extractResult({
              invocation: patched,
              ports: { artifacts, agent: artifactAgent, repair: structuredResultRepair },
            });
            if (!verdict.ok) {
              return {
                outcome: 'insufficient_evidence',
                evidence: '',
                rationale: `arbiter result.json unparseable: ${verdict.detail}`,
              };
            }
            const parsed = arbiterResultSchema.safeParse(verdict.result);
            if (!parsed.success) {
              return {
                outcome: 'insufficient_evidence',
                evidence: '',
                rationale: `arbiter result.json Zod parse error: ${parsed.error.message}`,
              };
            }
            return parsed.data as ImplementStepFinalReviewArbiterResult;
          }
        : undefined;

      implementStepLoop = new ImplementStepLoop({
        runImplement,
        runTypecheck,
        runSpecReview,
        runQualityReview,
        runFix: implRunFix,
        runRevalidation: async (ctx) => {
          const artifacts = artifactStoreForRun(String(ctx.runId), ctx.cwd);
          let taskValidationCommands: string[] = [];
          try {
            const manifestRaw = await artifacts.read(String(ctx.runId), 'task-manifest.json');
            const manifest = parseTaskManifest(manifestRaw);
            if (manifest.success) {
              const taskIndex = (ctx as StepLoopContext).stepIndex;
              const task = manifest.manifest.tasks.find((t) => t.n === taskIndex);
              if (task) {
                if (manifest.manifest.version === 2) {
                  taskValidationCommands =
                    (task as { validation_commands?: string[] }).validation_commands ?? [];
                } else {
                  taskValidationCommands = (task as { validation?: string[] }).validation ?? [];
                }
              }
            }
          } catch {
            // Task manifest might not be present or parseable; fall back to global only
          }
          const runDir =
            runRepository.findByUuid(String(ctx.runId))?.displayId ?? String(ctx.runId);
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
            commands: [...config.validation.commands, ...taskValidationCommands],
            timeoutSeconds: config.validation.timeout,
          });
          const failedCommand = vr.validationRun.commands.find((c) => c.outcome !== 'passed');
          await artifacts.write({
            runId: String(ctx.runId),
            phaseId: 'validate',
            relativePath: 'validation.result',
            contents: vr.passed ? 'passed\n' : 'failed\n',
          });
          return {
            validationRunId: vr.validationRun.id,
            passed: vr.passed,
            ...(failedCommand?.kind ? { category: failedCommand.kind } : {}),
          };
        },
        ...(runArbiter ? { runArbiter } : {}),
        ...(implementStepFinalReviewRunArbiter
          ? { runFinalReviewArbiter: implementStepFinalReviewRunArbiter }
          : {}),
        loops: loopRepository,
        events: persistingEventBusForLoop,
        implementProfile: AgentProfileName(implementProfileName),
        ...(implementFallbackProfileName
          ? { implementFallbackProfile: AgentProfileName(implementFallbackProfileName) }
          : {}),
        fixProfile: AgentProfileName(implFixProfileName),
        ...(implFixFallbackProfileName
          ? { fixFallbackProfile: AgentProfileName(implFixFallbackProfileName) }
          : {}),
        ...(terminalFixProfileName
          ? { terminalFixProfile: AgentProfileName(terminalFixProfileName) }
          : {}),
        loopHistory: implementStepHistory,
        // Reuses the same `git reset --hard` closure already declared for the
        // review-fix loop (rollbackFix at compose.ts:1844). The implement-step
        // loop is the only other consumer.
        revertFix: async (ctx: StepLoopContext, targetSha: string): Promise<boolean> => {
          try {
            execFileSync('git', ['reset', '--hard', targetSha], { cwd: ctx.cwd });
            return true;
          } catch {
            return false;
          }
        },
        git: gitAdapter,
        now: () => new Date(),
        idFactory: () => randomUUID(),
        reviewStateRepository,
        options: {
          deltaScopedReReview: config.phases.implement.deltaScopedReReview,
        },
      });

      // --- Plan-review loop (#666) ---
      // Captured here (not inline in the closures below) because
      // planReviewRunFix's `opts` parameter (PlanFixOptions) shadows the
      // outer composeRoot `opts` (ComposeOptions) within its own body.
      const planReviewPromptsRoot = join(opts.repoRoot, 'prompts');
      const planReviewProfileName = config.phases.planReview?.enabled
        ? resolveProfileForPhaseBound!('plan-review')
        : undefined;
      const planFixProfileName = config.phases.planReview?.enabled
        ? resolveProfileForPhaseBound!('plan-fix')
        : undefined;
      const planReviewDeltaScopedReReview = config.phases.planReview?.deltaScopedReReview ?? true;
      const planReviewArbiterProfileName = resolveArbiterProfileName(
        config.agent.phaseProfiles ?? {},
      );

      const planReviewArtifacts = artifactStoreForRun;

      const planReviewCheckManifestSync = async (
        ctx: import('@ai-sdlc/application').PlanReviewContext,
      ): Promise<string | null> => {
        const artifacts = planReviewArtifacts(String(ctx.runId), ctx.cwd);
        let planMd: string;
        try {
          planMd = await artifacts.read(String(ctx.runId), 'plan.md');
        } catch (e) {
          if (e instanceof ArtifactNotFoundError) return null;
          throw e;
        }
        let manifestJson: string | undefined;
        try {
          manifestJson = await artifacts.read(String(ctx.runId), 'task-manifest.json');
        } catch (e) {
          if (e instanceof ArtifactNotFoundError) {
            return null;
          } else {
            throw e;
          }
        }
        const result = validatePlanTaskList(planMd, manifestJson);
        return result.success ? null : result.error;
      };

      const computeSnapshot = async (
        cwd: string,
        _mode: import('@ai-sdlc/application').ReviewMode | undefined,
      ): Promise<import('@ai-sdlc/application').PlanReviewSnapshot | undefined> => {
        const planMdPath = join(cwd, 'plan.md');
        const manifestPath = join(cwd, 'task-manifest.json');
        const designPath = join(cwd, 'design.md');
        let planMdDigest: string;
        try {
          planMdDigest = createHash('sha256')
            .update(await fsReadFile(planMdPath, 'utf-8'), 'utf-8')
            .digest('hex');
        } catch {
          return undefined;
        }
        const snapshot: import('@ai-sdlc/application').PlanReviewSnapshot = {
          planMdDigest,
          planMdPath,
          capturedAt: new Date().toISOString(),
        };
        try {
          snapshot.manifestDigest = createHash('sha256')
            .update(await fsReadFile(manifestPath, 'utf-8'), 'utf-8')
            .digest('hex');
          snapshot.manifestPath = manifestPath;
        } catch {
          // optional
        }
        try {
          snapshot.designDigest = createHash('sha256')
            .update(await fsReadFile(designPath, 'utf-8'), 'utf-8')
            .digest('hex');
          snapshot.designPath = designPath;
        } catch {
          // optional
        }
        return snapshot;
      };

      const planReviewRunReview = async (
        ctx: import('@ai-sdlc/application').PlanReviewContext,
        reviewOpts?: import('@ai-sdlc/application').PlanReviewStepOptions,
      ): Promise<import('@ai-sdlc/application').PlanReviewResult> => {
        const profile = planReviewProfileName;
        if (!profile) {
          return { invocationId: '', agentOutcome: 'failed' };
        }
        const promptDir = join(baseTmpDir, 'plan-review-prompts');
        mkdirSync(promptDir, { recursive: true });
        const promptPath = join(
          promptDir,
          `plan-review-${String(ctx.runId)}-${ctx.iterationIndex}.md`,
        );
        const template = loadPromptTemplate('plan-review', 'plan-review', {
          promptsRoot: planReviewPromptsRoot,
        });
        let promptBody = await renderPrompt(template, {
          runId: String(ctx.runId),
          vars: {},
          artifacts: planReviewArtifacts(String(ctx.runId), ctx.cwd),
        });
        // (#716 — reviewer finding #1) When the loop passes reviewOpts for
        // iteration >= 2, APPEND the SCOPE / DISPOSITION GUIDANCE block to
        // the base prompt. NEVER substitute promptBody — that would discard
        // the plan.md/design.md artifact content and WORKSPACE_CONSTRAINTS
        // block the base prompt template renders.
        if (
          reviewOpts !== undefined &&
          ctx.iterationIndex >= 2 &&
          (reviewOpts.prevFindings !== undefined || reviewOpts.recentFixCitations !== undefined)
        ) {
          const scopeBlock = buildPlanReviewReviewScopeBlock(reviewOpts);
          promptBody = `${promptBody}\n\n${scopeBlock}`;
        }
        writeFileSync(promptPath, promptBody, 'utf-8');

        const startCommitSha = (() => {
          try {
            return execFileSync('git', ['rev-parse', 'HEAD'], {
              cwd: ctx.cwd,
              encoding: 'utf-8',
            }).trim();
          } catch {
            return resolveStartCommitSha(ctx.cwd, String(ctx.runId));
          }
        })();

        const isSemanticRetry = ctx.iterationIndex > 1;
        let invokeResult;
        try {
          invokeResult = await artifactAgent.invoke({
            profile: AgentProfileName(profile),
            promptPath,
            expectedArtifacts: [PLAN_REVIEW_FINDINGS_ARTIFACT],
            cwd: ctx.cwd,
            runId: String(ctx.runId),
            repoId: ctx.repoId,
            phaseId: 'plan-review',
            startCommitSha,
            metadata: {
              iteration: ctx.iterationIndex,
              invocation_type: isSemanticRetry ? 'semantic_retry' : 'initial',
            },
            ...(isSemanticRetry
              ? {
                  retryIntent: {
                    normalizedPhase: 'plan-review',
                    classification: 'semantic',
                    relevantArtifactPaths: [PLAN_REVIEW_FINDINGS_ARTIFACT],
                  },
                }
              : {}),
          });
        } catch {
          return {
            invocationId: '',
            agentOutcome: 'failed',
          };
        }
        const invocationId = newestInvocationId(String(ctx.runId));
        if (invokeResult.outcome !== 'success') {
          return {
            invocationId,
            agentOutcome: invokeResult.outcome,
          };
        }
        // Read findings and parse verdict; if missing, mark as failed so the loop retries.
        try {
          const findings = await planReviewArtifacts(String(ctx.runId), ctx.cwd).read(
            String(ctx.runId),
            PLAN_REVIEW_FINDINGS_ARTIFACT,
          );
          // (#716) Composition-root seam: when delta-scoped re-review is
          // enabled, thread the artifact-store-backed `EvidenceResolver`
          // into the parser so evidence is grounded against the live
          // artifacts. When it is disabled, preserve the reviewer-supplied
          // findings verbatim so the opt-out restores the pre-#716 data
          // contract bit-for-bit.
          let parsedFindings: Awaited<ReturnType<typeof parsePlanReviewFindings>>;
          if (planReviewDeltaScopedReReview) {
            parsedFindings = await parsePlanReviewFindings(
              findings,
              createPlanReviewEvidenceResolver(
                planReviewArtifacts(String(ctx.runId), ctx.cwd),
                String(ctx.runId),
              ),
            );
          } else {
            parsedFindings = await parsePlanReviewFindings(findings);
          }
          const mode = reviewOpts?.mode;
          const snapshot = await computeSnapshot(ctx.cwd, mode);
          if (snapshot) {
            agentInvocationRepository.update(AgentInvocationId(invocationId), {
              metadata: {
                review_scope_source: 'plan-review',
                review_mode: mode,
                review_snapshot_kind: 'plan_artifact',
                review_dimensions: ['plan'],
                review_snapshot_identity: snapshot.planMdDigest,
                ...(snapshot.manifestDigest
                  ? { review_base_identity: snapshot.manifestDigest }
                  : {}),
              },
            });
          }
          return {
            invocationId,
            agentOutcome: 'success',
            verdict: parsedFindings.verdict,
            ...(parsedFindings.knownLimitations
              ? {
                  knownLimitations: parsedFindings.knownLimitations
                    .map((line) => `- ${line}`)
                    .join('\n'),
                }
              : {}),
            findings: parsedFindings.findings as ReadonlyArray<PlanReviewFinding>,
            ...(snapshot ? { snapshot } : {}),
            ...(mode ? { mode } : {}),
          };
        } catch {
          return { invocationId, agentOutcome: 'failed' };
        }
      };

      const planReviewRunFix = async (
        ctx: import('@ai-sdlc/application').PlanReviewContext,
        opts: import('@ai-sdlc/application').PlanFixOptions,
      ): Promise<import('@ai-sdlc/application').PlanFixResult> => {
        const profile = planFixProfileName;
        if (!profile) {
          return { invocationId: '', agentOutcome: 'failed' };
        }
        const promptDir = join(baseTmpDir, 'plan-review-prompts');
        mkdirSync(promptDir, { recursive: true });
        const promptPath = join(
          promptDir,
          `plan-fix-${String(ctx.runId)}-${ctx.iterationIndex}.md`,
        );
        const template = loadPromptTemplate('plan-review', 'plan-fix', {
          promptsRoot: planReviewPromptsRoot,
        });
        const promptBody = await renderPrompt(template, {
          runId: String(ctx.runId),
          vars: {
            reconciliationContext: opts.reconciliationContext ?? '(none — first iteration)',
            manifestMismatch: opts.manifestMismatch ?? '(none)',
          },
          artifacts: planReviewArtifacts(String(ctx.runId), ctx.cwd),
        });
        const finalPrompt = buildPlanReviewFixPrompt(promptBody, {
          deterministicDiagnostic: opts.manifestMismatch,
        });
        writeFileSync(promptPath, finalPrompt, 'utf-8');

        const startCommitSha = (() => {
          try {
            return execFileSync('git', ['rev-parse', 'HEAD'], {
              cwd: ctx.cwd,
              encoding: 'utf-8',
            }).trim();
          } catch {
            return resolveStartCommitSha(ctx.cwd, String(ctx.runId));
          }
        })();

        const isDeterministic = !!opts.manifestMismatch;
        const isSemanticRetry = ctx.iterationIndex > 1 && !isDeterministic;
        let invokeResult;
        try {
          invokeResult = await artifactAgent.invoke({
            profile: AgentProfileName(profile),
            promptPath,
            expectedArtifacts: [PLAN_FIX_RESULT_ARTIFACT, 'plan.md'],
            cwd: ctx.cwd,
            runId: String(ctx.runId),
            repoId: ctx.repoId,
            phaseId: 'plan-fix',
            startCommitSha,
            metadata: {
              iteration: ctx.iterationIndex,
              invocation_type: isDeterministic
                ? 'deterministic_fix'
                : isSemanticRetry
                  ? 'semantic_retry'
                  : 'initial',
            },
            ...(isSemanticRetry
              ? {
                  retryIntent: {
                    normalizedPhase: 'plan-fix',
                    classification: 'semantic',
                    relevantArtifactPaths: [PLAN_FIX_RESULT_ARTIFACT, 'plan.md'],
                  },
                }
              : {}),
          });
        } catch {
          return { invocationId: '', agentOutcome: 'failed' };
        }
        const invocationId = newestInvocationId(String(ctx.runId));
        if (invokeResult.outcome !== 'success') {
          return {
            invocationId,
            agentOutcome: invokeResult.outcome,
          };
        }
        const inv = agentInvocationRepository.findById(AgentInvocationId(invocationId));
        if (!inv) {
          return { invocationId, agentOutcome: 'failed' };
        }
        const patched = inv.resultJsonPath
          ? inv
          : { ...inv, resultJsonPath: PLAN_FIX_RESULT_ARTIFACT };
        const verdict = await extractResult({
          invocation: patched,
          ports: {
            artifacts: planReviewArtifacts(String(ctx.runId), ctx.cwd),
            agent: artifactAgent,
            repair: structuredResultRepair,
          },
        });
        if (!verdict.ok) {
          return { invocationId, agentOutcome: 'failed' };
        }
        const parsed = planFixResultSchema.safeParse(verdict.result);
        if (!parsed.success) {
          return { invocationId, agentOutcome: 'failed' };
        }
        const data = parsed.data;
        return {
          invocationId,
          agentOutcome: 'success',
          headBeforeFix: startCommitSha,
          verdict: data.verdict,
          summary: data.summary,
          ...('rebuttal' in data && data.rebuttal ? { rebuttal: data.rebuttal } : {}),
        };
      };

      type PlanReviewArbiterResult = Awaited<
        ReturnType<Required<PlanReviewLoopDeps>['runArbiter']>
      >;
      const planReviewRunArbiter: PlanReviewLoopDeps['runArbiter'] | undefined =
        planReviewArbiterProfileName
          ? async (
              ctx: import('@ai-sdlc/application').PlanReviewContext,
              fixResult: import('@ai-sdlc/application').PlanFixResult,
            ): Promise<PlanReviewArbiterResult> => {
              const promptDir = join(baseTmpDir, 'plan-review-prompts');
              mkdirSync(promptDir, { recursive: true });
              const promptPath = join(
                promptDir,
                `plan-review-arbiter-${String(ctx.runId)}-${ctx.iterationIndex}.md`,
              );
              const artifacts = artifactStoreForRun(String(ctx.runId), ctx.cwd);
              const {
                planExcerpt,
                findingsExcerpt,
                fixExcerpt,
                manifestExcerpt,
                designExcerpt,
              } = await readPlanReviewExcerpts(artifacts, String(ctx.runId));
              const arbiterPrompt = buildPlanReviewArbiterPrompt(
                { cwd: ctx.cwd, runId: String(ctx.runId) },
                {
                  planExcerpt,
                  findingsExcerpt,
                  fixExcerpt,
                  manifestExcerpt,
                  designExcerpt,
                  fixRebuttal: fixResult.rebuttal ?? '',
                },
              );
              writeFileSync(promptPath, arbiterPrompt, 'utf-8');

              const startCommitSha = (() => {
                try {
                  return execFileSync('git', ['rev-parse', 'HEAD'], {
                    cwd: ctx.cwd,
                    encoding: 'utf-8',
                  }).trim();
                } catch {
                  return resolveStartCommitSha(ctx.cwd, String(ctx.runId));
                }
              })();

              try {
                rmSync(join(ctx.cwd, 'result.json'), { force: true });
              } catch {}

              try {
                await artifactAgent.invoke({
                  profile: AgentProfileName(planReviewArbiterProfileName),
                  promptPath,
                  expectedArtifacts: ['result.json'],
                  cwd: ctx.cwd,
                  runId: String(ctx.runId),
                  repoId: ctx.repoId,
                  phaseId: 'plan-review-arbiter',
                  startCommitSha,
                  metadata: {
                    iteration: ctx.iterationIndex,
                    invocation_type: 'initial',
                  },
                });
              } catch (err) {
                return {
                  outcome: 'insufficient_evidence',
                  evidence: '',
                  rationale: `arbiter invocation threw: ${err instanceof Error ? err.message : String(err)}`,
                };
              }
              const invocationId = newestInvocationId(String(ctx.runId));
              const inv = agentInvocationRepository.findById(AgentInvocationId(invocationId));
              if (!inv) {
                return {
                  outcome: 'insufficient_evidence',
                  evidence: '',
                  rationale: 'arbiter invocation produced no row',
                };
              }
              const patched = inv.resultJsonPath ? inv : { ...inv, resultJsonPath: 'result.json' };
              const verdict = await extractResult({
                invocation: patched,
                ports: { artifacts, agent: artifactAgent, repair: structuredResultRepair },
              });
              if (!verdict.ok) {
                return {
                  outcome: 'insufficient_evidence',
                  evidence: '',
                  rationale: `arbiter result.json unparseable: ${verdict.detail}`,
                };
              }
              const parsed = arbiterResultSchema.safeParse(verdict.result);
              if (!parsed.success) {
                return {
                  outcome: 'insufficient_evidence',
                  evidence: '',
                  rationale: 'Zod parse error',
                };
              }
              return parsed.data as PlanReviewArbiterResult;
            }
          : undefined;

      const planReviewFinalReviewRunArbiter:
        | PlanReviewLoopDeps['runFinalReviewArbiter']
        | undefined = planReviewArbiterProfileName
        ? async (
            ctx: import('@ai-sdlc/application').PlanReviewContext,
            // Reserved for future use: the trailing arbiter's prompt may include
            // a summary of the failing review verdict (verdict, invocationId).
            // Part of the `runFinalReviewArbiter` type contract — do not drop.
            _finalReview: import('@ai-sdlc/application').PlanReviewResult,
          ): Promise<PlanReviewArbiterResult> => {
            const promptDir = join(baseTmpDir, 'plan-review-prompts');
            mkdirSync(promptDir, { recursive: true });
            const promptPath = join(
              promptDir,
              `plan-review-final-review-arbiter-${String(ctx.runId)}-${ctx.iterationIndex}.md`,
            );
            const artifacts = artifactStoreForRun(String(ctx.runId), ctx.cwd);
            const { planExcerpt, findingsExcerpt, manifestExcerpt, designExcerpt } =
              await readPlanReviewFinalExcerpts(artifacts, String(ctx.runId));
            const arbiterPrompt = buildPlanReviewFinalReviewArbiterPrompt(
              { cwd: ctx.cwd, runId: String(ctx.runId) },
              { planExcerpt, findingsExcerpt, manifestExcerpt, designExcerpt },
            );
            writeFileSync(promptPath, arbiterPrompt, 'utf-8');

            const startCommitSha = (() => {
              try {
                return execFileSync('git', ['rev-parse', 'HEAD'], {
                  cwd: ctx.cwd,
                  encoding: 'utf-8',
                }).trim();
              } catch {
                return resolveStartCommitSha(ctx.cwd, String(ctx.runId));
              }
            })();

            try {
              rmSync(join(ctx.cwd, 'result.json'), { force: true });
            } catch {}

            try {
              await artifactAgent.invoke({
                profile: AgentProfileName(planReviewArbiterProfileName),
                promptPath,
                expectedArtifacts: ['result.json'],
                cwd: ctx.cwd,
                runId: String(ctx.runId),
                repoId: ctx.repoId,
                phaseId: 'plan-review-arbiter',
                startCommitSha,
                metadata: {
                  iteration: ctx.iterationIndex,
                  invocation_type: 'initial',
                },
              });
            } catch (err) {
              return {
                outcome: 'insufficient_evidence',
                evidence: '',
                rationale: `arbiter invocation threw: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
            const invocationId = newestInvocationId(String(ctx.runId));
            const inv = agentInvocationRepository.findById(AgentInvocationId(invocationId));
            if (!inv) {
              return {
                outcome: 'insufficient_evidence',
                evidence: '',
                rationale: 'arbiter invocation produced no row',
              };
            }
            const patched = inv.resultJsonPath ? inv : { ...inv, resultJsonPath: 'result.json' };
            const verdict = await extractResult({
              invocation: patched,
              ports: { artifacts, agent: artifactAgent, repair: structuredResultRepair },
            });
            if (!verdict.ok) {
              return {
                outcome: 'insufficient_evidence',
                evidence: '',
                rationale: `arbiter result.json unparseable: ${verdict.detail}`,
              };
            }
            const parsed = arbiterResultSchema.safeParse(verdict.result);
            if (!parsed.success) {
              return {
                outcome: 'insufficient_evidence',
                evidence: '',
                rationale: 'Zod parse error',
              };
            }
            return parsed.data as PlanReviewArbiterResult;
          }
        : undefined;

      const planReviewLoop = new PlanReviewLoop({
        runReview: planReviewRunReview,
        runFix: planReviewRunFix,
        checkManifestSync: planReviewCheckManifestSync,
        computeLastFixDiffCitations: (cwd, headBeforeFix) =>
          getRecentFixCitations(cwd, headBeforeFix),
        ...(planReviewRunArbiter ? { runArbiter: planReviewRunArbiter } : {}),
        ...(planReviewFinalReviewRunArbiter
          ? { runFinalReviewArbiter: planReviewFinalReviewRunArbiter }
          : {}),
        loops: loopRepository,
        events: persistingEventBusForLoop,
        reviewerMaxRetries: 2,
        now: () => new Date(),
        idFactory: () => randomUUID(),
        reviewStateRepository,
        options: {
          // (#716) Composition-root seam: thread the operator-configured
          // `deltaScopedReReview` flag into the loop. When false, the loop
          // skips the evidence-bound gate, skips the SCOPE / DISPOSITION
          // GUIDANCE block, and preserves reviewer-supplied evidence and
          // verdicts as-is — restoring pre-#716 behavior bit-for-bit.
          deltaScopedReReview: planReviewDeltaScopedReReview,
        },
      });

      runStep = async (sctx: {
        stepIndex: number;
        stepTitle: string;
        cwd: string;
        ctx: import('@ai-sdlc/application').PhaseHandlerContext;
        manifest: TaskManifest;
        planMd: string;
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
          manifest: sctx.manifest,
          planMd: sctx.planMd,
          options: {
            holisticThresholdIteration: config.phases.implement.holisticThresholdIteration,
            holisticThresholdFindings: config.phases.implement.holisticThresholdFindings,
          },
        });
        return { outcome: result.outcome };
      };

      // Wire remaining phase handlers that require agent dependencies
      phaseRegistry.register(new PlanDesignHandler());
      phaseRegistry.register(
        new PlanWriteHandler({
          maxRepairAttempts: config.phases.planWrite?.maxRepairAttempts ?? 2,
        }),
      );
      phaseRegistry.register(
        new PlanReviewHandler({
          loop: planReviewLoop,
          maxIterations: config.phases.planReview?.maxIterations ?? 3,
          enabled: config.phases.planReview?.enabled === true,
        }),
      );
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

      const implementArtifactGuard = new ImplementArtifactGuard({
        artifacts: artifactStoreForRun,
        git: gitAdapter,
      });

      const synthesizeFromTranscript = new SynthesizeFromTranscript({
        artifacts: artifactStoreForRun,
        git: gitAdapter,
        agent: artifactAgent,
        eventBus: persistingEventBusForLoop,
      });

      if (runStep !== undefined) {
        phaseRegistry.register(
          new ImplementHandler({
            steps: stepRepository,
            runStep,
            setup: worktreeSetup,
            lintTaskSize: lintTaskSizeDep,
          }),
        );
      }

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

      // Architect pass (#668). Runs once before the review-fix loop when
      // `phases.reviewFix.architectPass.enabled` is true. Returns the
      // validated plan or undefined (fail-soft). Mirrors the legacy
      // shell-side architect in scripts/legacy/ai-run-issue-v2:4338-4457.
      const architectPassEnabled = config.phases.reviewFix.architectPass?.enabled ?? false;
      const architectPassTimeoutMinutes =
        config.phases.reviewFix.architectPass?.timeoutMinutes ?? 10;
      const architectProfileName: string | undefined = resolveArchitectProfileName(
        config.agent.phaseProfiles ?? {},
        config.agent.roles ?? {},
      );

      const maybeRunArchitect = async (
        ctx: import('@ai-sdlc/application').PhaseHandlerContext,
        baseTmpDir: string,
      ): Promise<
        | {
            version: 1;
            tasks: Array<{
              task_id: string;
              approach: string;
              conflicts_resolved: string[];
              constraints: string[];
              depends_on: string[];
            }>;
          }
        | undefined
      > => {
        if (!architectPassEnabled) {
          persistingEventBusForLoop.publish(String(ctx.runUuid), {
            runId: String(ctx.runUuid),
            level: 'info',
            type: 'review_fix.architect_pass_skipped',
            message: 'architect pass skipped (disabled in config)',
            timestamp: new Date().toISOString(),
            metadata: { reason: 'disabled' },
          });
          return undefined;
        }

        // Read the review manifest; skip if there are no fix tasks.
        let manifestJson = '';
        try {
          manifestJson = await ctx.artifacts.read(String(ctx.runUuid), 'review-task-manifest.json');
        } catch {
          // No manifest — let the loop fail downstream with "no findings to fix".
          persistingEventBusForLoop.publish(String(ctx.runUuid), {
            runId: String(ctx.runUuid),
            level: 'info',
            type: 'review_fix.architect_pass_skipped',
            message: 'architect pass skipped (no review-task-manifest.json)',
            timestamp: new Date().toISOString(),
            metadata: { reason: 'no_fix_tasks' },
          });
          return undefined;
        }

        let fixTaskCount = 0;
        try {
          const parsed = JSON.parse(manifestJson) as unknown;
          const tasks = Array.isArray(parsed)
            ? parsed
            : parsed &&
                typeof parsed === 'object' &&
                Array.isArray((parsed as Record<string, unknown>).tasks)
              ? (parsed as Record<string, unknown>).tasks
              : [];
          fixTaskCount = (tasks as Array<{ action?: string | null }>).filter(
            (t) => t?.action === 'fix' || t?.action == null,
          ).length;
        } catch {
          // Manifest isn't valid JSON — let the loop fail downstream.
          fixTaskCount = 0;
        }

        if (fixTaskCount === 0) {
          persistingEventBusForLoop.publish(String(ctx.runUuid), {
            runId: String(ctx.runUuid),
            level: 'info',
            type: 'review_fix.architect_pass_skipped',
            message: 'architect pass skipped (no fix tasks in manifest)',
            timestamp: new Date().toISOString(),
            metadata: { reason: 'no_fix_tasks' },
          });
          return undefined;
        }

        if (!architectProfileName) {
          // No resolvable profile — surface as a config error (mirrors the
          // existing unknown-phase handling in run-agent.ts:300-304).
          throw new Error(
            'architect pass enabled but no profile resolved (configure phaseProfiles["fix-review-architect"] or roles.planner or phaseProfiles["plan-design"])',
          );
        }

        persistingEventBusForLoop.publish(String(ctx.runUuid), {
          runId: String(ctx.runUuid),
          level: 'info',
          type: 'review_fix.architect_pass_started',
          message: 'cohesive architect pass starting',
          timestamp: new Date().toISOString(),
          metadata: { task_count: fixTaskCount, profile: architectProfileName },
        });

        // Capture pre-architect HEAD for the mutation guard.
        let preArchitectSha: string;
        try {
          preArchitectSha = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: ctx.cwd,
            encoding: 'utf-8',
          }).trim();
        } catch {
          preArchitectSha = '0'.repeat(40);
        }

        // Read the review.md and review-triage.md excerpts (best-effort).
        let reviewMd = '';
        let triageMd = '';
        try {
          reviewMd = await ctx.artifacts.read(String(ctx.runUuid), 'review.md');
        } catch {
          reviewMd = '';
        }
        try {
          triageMd = await ctx.artifacts.read(String(ctx.runUuid), 'review-triage.md');
        } catch {
          triageMd = '';
        }

        // Write the prompt to a stable location so the agent can read it.
        const promptDir = join(baseTmpDir, 'architect-prompts');
        let promptPath = '';
        try {
          mkdirSync(promptDir, { recursive: true });
          promptPath = join(promptDir, `architect-${String(ctx.runUuid)}.md`);
          const prompt = buildArchitectPrompt(
            { cwd: ctx.cwd, repoId: ctx.repoFullName },
            { manifest: manifestJson, reviewMd, triageMd },
          );
          writeFileSync(promptPath, prompt, 'utf-8');
        } catch (err) {
          // Fail-soft: I/O errors when writing the prompt must not crash the run.
          persistingEventBusForLoop.publish(String(ctx.runUuid), {
            runId: String(ctx.runUuid),
            level: 'warn',
            type: 'review_fix.architect_pass_failed',
            message: `architect pass failed to write prompt: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: new Date().toISOString(),
            metadata: { reason: 'io_error' },
          });
          return undefined;
        }

        // Invoke the architect agent.
        let agentOutcome: string = 'success';
        try {
          const result = await artifactAgent.invoke({
            profile: AgentProfileName(architectProfileName),
            promptPath,
            expectedArtifacts: ['review-fix-plan.json'],
            cwd: ctx.cwd,
            runId: String(ctx.runUuid),
            repoId: ctx.repoFullName,
            phaseId: 'fix-review-architect',
            startCommitSha: preArchitectSha,
            timeoutMs: architectPassTimeoutMinutes * 60_000,
            metadata: {
              invocation_type: 'initial',
            },
          });
          agentOutcome = result.outcome;
        } catch (err) {
          agentOutcome = 'failed';
          persistingEventBusForLoop.publish(String(ctx.runUuid), {
            runId: String(ctx.runUuid),
            level: 'warn',
            type: 'review_fix.architect_pass_failed',
            message: `architect pass failed: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: new Date().toISOString(),
            metadata: { reason: 'exit_code' },
          });
          return undefined;
        }

        if (agentOutcome !== 'success') {
          persistingEventBusForLoop.publish(String(ctx.runUuid), {
            runId: String(ctx.runUuid),
            level: 'warn',
            type: 'review_fix.architect_pass_failed',
            message: `architect pass failed with outcome: ${agentOutcome}`,
            timestamp: new Date().toISOString(),
            metadata: { reason: 'exit_code' },
          });
          return undefined;
        }

        // Mutation guard: tracked-file diffs mean the architect mutated
        // code. Hard-reset to preArchitectSha and discard the plan. Untracked output
        // files (review-fix-plan.json) are expected and not mutations.
        // We use inlined orchestrator-diff exclusions to ignore allowed
        // orchestrator artifacts/manifests.
        const targetSha = preArchitectSha === '0'.repeat(40) ? 'HEAD' : preArchitectSha;
        try {
          const orchestratorDiffExclusions = [
            'review-triage.md',
            'code-review.md',
            'review.md',
            'review-task-manifest.json',
            'task-manifest.json',
            'arbiter-result.json',
            'review-loop-history.json',
            'implement-step-history-*.json',
            'compound-draft.md',
            'validation.result',
            'result.json',
            'fix-validate-done.marker',
            'plan-review-passed.marker',
            'review-fix-plan.json',
            '*.patch',
          ];
          const exclusions = orchestratorDiffExclusions.map((p) => `:!${p}`);
          execFileSync('git', ['diff', '--exit-code', targetSha, '--', '.', ...exclusions], {
            cwd: ctx.cwd,
          });
        } catch {
          try {
            execFileSync('git', ['reset', '--hard', targetSha], { cwd: ctx.cwd });
          } catch {
            // best-effort reset; the loop will continue without a plan
          }
          persistingEventBusForLoop.publish(String(ctx.runUuid), {
            runId: String(ctx.runUuid),
            level: 'warn',
            type: 'review_fix.architect_pass_failed',
            message: 'architect pass mutated code — plan discarded',
            timestamp: new Date().toISOString(),
            metadata: { reason: 'mutation' },
          });
          return undefined;
        }

        // Read and validate the plan.
        const planPath = join(ctx.cwd, 'review-fix-plan.json');
        let planRaw: string;
        try {
          planRaw = readFileSync(planPath, 'utf-8');
        } catch {
          persistingEventBusForLoop.publish(String(ctx.runUuid), {
            runId: String(ctx.runUuid),
            level: 'warn',
            type: 'review_fix.architect_pass_failed',
            message: 'architect pass produced no plan file',
            timestamp: new Date().toISOString(),
            metadata: { reason: 'no_output' },
          });
          return undefined;
        }

        let planJson: unknown;
        try {
          planJson = JSON.parse(planRaw);
        } catch {
          persistingEventBusForLoop.publish(String(ctx.runUuid), {
            runId: String(ctx.runUuid),
            level: 'warn',
            type: 'review_fix.architect_pass_failed',
            message: 'architect pass produced unparseable plan JSON',
            timestamp: new Date().toISOString(),
            metadata: { reason: 'invalid_structure' },
          });
          return undefined;
        }

        const validated = architectPlanSchema.safeParse(planJson);
        if (!validated.success) {
          persistingEventBusForLoop.publish(String(ctx.runUuid), {
            runId: String(ctx.runUuid),
            level: 'warn',
            type: 'review_fix.architect_pass_failed',
            message: `architect pass plan failed schema validation: ${validated.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; ')}`,
            timestamp: new Date().toISOString(),
            metadata: { reason: 'invalid_structure' },
          });
          return undefined;
        }

        persistingEventBusForLoop.publish(String(ctx.runUuid), {
          runId: String(ctx.runUuid),
          level: 'info',
          type: 'review_fix.architect_pass_completed',
          message: 'architect pass completed',
          timestamp: new Date().toISOString(),
          metadata: { tasks: validated.data.tasks.length },
        });

        return validated.data;
      };

      phaseRegistry.register(
        new ReviewFixHandler({
          runLoop: async (ctx) => {
            const architectPlan = await maybeRunArchitect(ctx, baseTmpDir);
            const result = await reviewFixLoopInstance.execute({
              runId: RunId(ctx.runUuid),
              phaseId: PhaseName('review-fix'),
              repoId: ctx.repoFullName,
              cwd: ctx.cwd,
              maxIterations: config.phases.reviewFix.maxIterations,
              ...(config.phases.reviewFix.maxConsecutiveFixFailures !== undefined
                ? { maxConsecutiveFixFailures: config.phases.reviewFix.maxConsecutiveFixFailures }
                : {}),
              ...(config.phases.reviewFix.maxTotalFixAttempts !== undefined
                ? { maxTotalFixAttempts: config.phases.reviewFix.maxTotalFixAttempts }
                : {}),
              blockOnSeverity: config.phases.reviewFix.blockOnSeverity,
              reviewProfile: AgentProfileName(reviewProfileName),
              fixProfile: AgentProfileName(resolveProfileBound('fix-review')),
              options: {
                endOnReview: config.phases.reviewFix.endOnReview,
                deltaScopedReReview: config.phases.reviewFix.deltaScopedReReview,
                trendAwareExit: {
                  enabled: config.phases.reviewFix.trendAwareExit.enabled,
                  mode: config.phases.reviewFix.trendAwareExit.mode,
                  window: config.phases.reviewFix.trendAwareExit.window,
                },
              },
              ...(architectPlan ? { architectPlan } : {}),
            });
            return {
              phaseOutcome: result.phaseOutcome,
              loopStatus: result.loopStatus,
              ...(result.needsHumanReview !== undefined
                ? { needsHumanReview: result.needsHumanReview }
                : {}),
            };
          },
        }),
      );

      phaseRegistry.register(
        new CreatePrHandler({
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

            // Resolve the per-run base branch at poll time so it follows the
            // value the run was started with (CLI --base-branch or default).
            const runRecord = runRepository.findByUuid(ctx.runUuid);
            const baseBranch = runRecord?.baseBranch ?? opts.baseBranch ?? resolvedDefaultBranch;

            const poller = buildPrReviewPoller({
              maxPolls: config.phases.postPrReview?.maxPolls ?? 10,
              pollIntervalMs: (config.phases.postPrReview?.pollIntervalSeconds ?? 60) * 1000,
              readyMaxDays: config.timeouts.readyMaxDays,
              phaseStartedAt: ctx.now(),
              baseBranch,
              ...(config.phases.postPrReview?.firstReviewGraceWindowSeconds !== undefined
                ? {
                    firstReviewGraceWindowSeconds:
                      config.phases.postPrReview.firstReviewGraceWindowSeconds,
                  }
                : {}),
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
        eventBus,
        now: () => new Date(),
        readyMaxDays,
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
              eventBus,
              now: () => new Date(),
            });
          }
        },
        resolvePrContext: async (run: RunRecord) => resolvePrContextForRun(run),
      }),
      runRepository,
      leases: workerLeaseRepository,
      queue: jobQueue,
      eventBus,
      now: () => new Date(),
      logger: sweepLogger,
    });

  const buildOrphanedRunsSweeper = () =>
    new OrphanedRunsSweeper({
      runRepository,
      leases: workerLeaseRepository,
      queue: jobQueue,
      eventBus,
      now: () => new Date(),
      logger: sweepLogger,
    });

  const workerLoopDeps: Omit<WorkerLoopDeps, 'recoverableRunIds'> | undefined =
    runExecutor !== undefined
      ? {
          registry: workerRegistry,
          queue: jobQueue,
          leases: workerLeaseRepository,
          repos: registryBackedRepo,
          executeRun: async ({ run, signal: _signal }) => {
            runRepository.update(run.uuid, { pid: process.pid });
            const result = await runExecutor.execute({ run, skip: [], presentArtifacts: [] });
            return { ok: result.run.status === 'passed' };
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
            const sha = await gitAdapter.headCommitSha(worktreePath);
            runRepository.update(r.uuid, { startCommitSha: sha });
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
    repos: registryBackedRepo,
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
      },
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
      ...opts,
    };
  };

  return {
    runRepository,
    phaseRepository,
    phaseRegistry,
    reapOrphanedTestWorkers,
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
    repoFullName: resolvedRepoFullName ?? '',
    targetRepoRoot: targetRoot,
    runValidation,
    startIssueRun,
    loadRepositoryForRun,
    cancelRun,
    checkMergeReadiness,
    stepRepository,
    resumeRun,
    retryFailedPhase,
    runsDir,
    baseTmpDir,
    defaultBranch: resolvedDefaultBranch,
    repoDefaultBranch: resolvedDefaultBranch,
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
    serveSweepIntervalSeconds,
    buildWaitingRunsSweeper,
    buildOrphanedRunsSweeper,
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
